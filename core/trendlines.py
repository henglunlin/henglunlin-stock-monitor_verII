# -*- coding: utf-8 -*-
"""
core/trendlines.py
===================
K 線訊號圖用的即時趨勢線計算——上升(支撐) + 下降(壓力)，各分短期/中短期/中長期
三個等級，畫在蠟燭圖上讓人一眼看出目前價格相對哪一條趨勢線。

跟 precompute_trendlines.py 的關係
----------------------------------
precompute_trendlines.py 是每日排程腳本，只算「下降(壓力)」一個方向、只給
signal_module/precomputed_trendline_breakout.py 的「下降趨勢線突破」訊號用
（只關心「明天的一個突破價位數字」，不關心整條線怎麼畫）。這裡是第三份複本：
核心的上緣凸包演算法一樣，但

  1. 多算「上升(支撐)」方向——用下緣凸包(lower hull)，是上緣凸包的鏡像。
  2. 回傳的是「可以直接畫成兩點線段」的座標，不是單一個突破價位數字。
  3. 隨每次 K 線圖請求即時算，不是每天排程先算好——K 線圖是使用者主動點開才會
     打的 API，用量遠低於「盤中每次刷新都要掃過全市場」的訊號引擎，即時算划得來，
     也不需要再多維護一個 JSON 檔案跟 GitHub Actions 排程。

precompute_trendlines.py 自己的註解就說了「跟 signal_module 那份判斷同一件事，
為了維持獨立可執行刻意複製了一份，兩邊需要修改記得同步」——這裡是同樣的取捨，
三個地方的 SHORT/MID/LONG_MAX_DAYS 等參數改動時要一起同步。
"""
from __future__ import annotations

SHORT_MAX_DAYS = 6
MID_MAX_DAYS = 23
LONG_MAX_DAYS = 66  # 一季，最常用的長期掃描區間
MIN_ANCHOR_GAP_DAYS = 2
MIN_BREAKOUT_GAP_DAYS = 2

TIER_DEFS = [
    ("short", 0, SHORT_MAX_DAYS, "短期"),
    ("mid", SHORT_MAX_DAYS, MID_MAX_DAYS, "中短期"),
    ("long", MID_MAX_DAYS, LONG_MAX_DAYS, "中長期"),
]

__all__ = ["compute_trendlines"]


def _cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _upper_hull(points):
    """凸包上緣：連接局部高點，用來畫「下降(壓力)」趨勢線。"""
    hull = []
    for p in points:
        while len(hull) >= 2 and _cross(hull[-2], hull[-1], p) >= 0:
            hull.pop()
        hull.append(p)
    return hull


def _lower_hull(points):
    """凸包下緣：連接局部低點，用來畫「上升(支撐)」趨勢線。是上緣凸包的鏡像
    （pop 條件的不等式方向相反），跟 precompute_trendlines.py 的 _upper_hull
    刻意保持同樣的寫法風格，方便日後對照。"""
    hull = []
    for p in points:
        while len(hull) >= 2 and _cross(hull[-2], hull[-1], p) <= 0:
            hull.pop()
        hull.append(p)
    return hull


def _hull_edges(values, end_idx, lookback, min_gap, *, use_lower: bool):
    start_pos = max(0, end_idx - lookback)
    positions = list(range(start_pos, end_idx))
    if len(positions) < 2:
        return []
    points = [(pos, float(values[pos])) for pos in positions]
    hull = (_lower_hull if use_lower else _upper_hull)(points)
    edges = []
    for i in range(len(hull) - 1):
        (x1, y1), (x2, y2) = hull[i], hull[i + 1]
        # 下降(壓力)：後面的高點比前面低，才是「往下走」的一段
        # 上升(支撐)：後面的低點比前面高，才是「往上走」的一段
        if not use_lower and y2 < y1 and (x2 - x1) > min_gap:
            edges.append((x1, x2, y1, y2))
        elif use_lower and y2 > y1 and (x2 - x1) > min_gap:
            edges.append((x1, x2, y1, y2))
    return edges


def _select_edge(edges, end_idx, min_days, max_days):
    candidates = [
        e for e in edges
        if min_days < (end_idx - e[0]) <= max_days
        and (end_idx - e[1]) >= MIN_BREAKOUT_GAP_DAYS
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda e: e[1])


def _compute_tiers(values, end_idx: int, *, use_lower: bool) -> dict:
    result = {}
    for tier_key, min_days, max_days, tier_label in TIER_DEFS:
        edges = _hull_edges(values, end_idx, LONG_MAX_DAYS, MIN_ANCHOR_GAP_DAYS, use_lower=use_lower)
        edge = _select_edge(edges, end_idx, min_days, max_days)
        if edge is None:
            continue
        x1, x2, y1, y2 = edge
        slope = (y2 - y1) / (x2 - x1)
        intercept = y1 - slope * x1
        current_price = slope * end_idx + intercept
        result[tier_key] = {
            "tier_label": tier_label,
            "anchor1_idx": x1, "anchor2_idx": x2,
            "anchor1_price": round(float(y1), 2), "anchor2_price": round(float(y2), 2),
            "current_idx": end_idx, "current_price": round(float(current_price), 2),
            "slope": slope, "intercept": intercept,
        }
    return result


def compute_trendlines(dates: list, highs, lows) -> dict:
    """
    dates: 由舊到新排序的日期字串清單（跟蠟燭圖同一份索引）。
    highs / lows: 對應的最高價／最低價序列（list 或 pandas Series 皆可，
                  這裡只用位置索引存取，不依賴 pandas 特定型別）。

    回傳 {"resistance": {tier_key: {...}}, "support": {tier_key: {...}}}，
    每個 tier 的 *_idx 是「在 dates 清單裡的位置」，價格用 anchor1/anchor2/current
    三個點表示（current 是這條線延伸到最新一天的價位，即「目前這條線在哪裡」）。

    刻意不在這裡轉成日期字串或做顯示範圍裁切——那是「這份資料要怎麼畫」的決定，
    留給呼叫端（core/signals.py 的 compute_historical_signals）處理，這支只管
    純數值計算，方便單獨測試。
    """
    end_idx = len(dates) - 1
    if end_idx < 1:
        return {"resistance": {}, "support": {}}
    return {
        "resistance": _compute_tiers(list(highs), end_idx, use_lower=False),
        "support": _compute_tiers(list(lows), end_idx, use_lower=True),
    }
