"""Prompt construction for the 30-minute / final aggregation model."""

from __future__ import annotations

import json
from typing import Sequence

SYSTEM_PROMPT = """あなたは学習セッションの時系列観察ログを統合して分析するアシスタントです。

厳守事項:
- 入力ログに存在しない行動、原因、出来事を作り出さない。
- 時刻順に何がどう変化したかを説明する。
- 欠損区間は欠損として扱い、推測で埋めない。
- 改善案は次回すぐ実行できる具体的な行動にする。精神論を書かない。
- 医学的診断、心理学的診断、人格評価を行わない。
- 集中度は観察された行動からの推定値であり、心の状態の測定値ではない。
- 同じ助言を言い換えて繰り返さない。
- 出力はJSONオブジェクトのみ。前置き、説明、コードフェンスを付けない。
"""

OUTPUT_SCHEMA = """{
  "summary": "全体の要約を日本語で3-5文",
  "concentration": {
    "average_score": 0-100の数値,
    "trend": "improving" | "declining" | "stable" | "fluctuating" | "unknown",
    "high_periods": [{"start": "ISO8601", "end": "ISO8601", "note": "根拠"}],
    "low_periods": [{"start": "ISO8601", "end": "ISO8601", "note": "根拠"}]
  },
  "observed_patterns": ["ログから読み取れた傾向"],
  "bottlenecks": ["学習を妨げていた具体的要因"],
  "recommendations": [
    {"priority": 1, "title": "改善案", "reason": "ログ上の根拠", "action": "次回行う具体的行動"}
  ],
  "data_quality": {
    "coverage_ratio": 0.0-1.0,
    "warnings": ["データ上の注意点"]
  }
}"""


def compact_chunk_rows(rows: Sequence[dict]) -> list[dict]:
    """Reduce chunk analyses to the fields the LLM actually reasons over.

    Keeps the prompt inside an 8k context for a full 30-minute window and stops
    runtime//model metadata from leaking into the narrative.
    """
    compact = []
    for row in rows:
        metrics = row.get("metrics", {})
        compact.append(
            {
                "t": row.get("chunk_started_at") or row.get("created_at"),
                "seg": row.get("segment_index"),
                "idx": row.get("chunk_index"),
                "score": metrics.get("concentration_score"),
                "level": metrics.get("concentration_level"),
                "presence": metrics.get("presence"),
                "activity": metrics.get("primary_activity"),
                "phone": metrics.get("phone_use"),
                "away": metrics.get("away_from_desk"),
                "conf": metrics.get("confidence"),
                "note": metrics.get("status_summary"),
            }
        )
    return compact


def build_prompt(
    session_id: str,
    analysis_type: str,
    window_start: str,
    window_end: str,
    chunk_rows: Sequence[dict],
    missing_chunk_count: int,
    expected_chunk_count: int,
) -> str:
    compact = compact_chunk_rows(chunk_rows)
    label = "セッション全体の最終分析" if analysis_type == "final" else "30分区間の分析"

    return f"""{SYSTEM_PROMPT}

## タスク
{label}を行ってください。

## 対象
session_id: {session_id}
期間: {window_start} 〜 {window_end}
分析できたチャンク数: {len(compact)}
欠損チャンク数: {missing_chunk_count}
理論上の最大チャンク数: {expected_chunk_count}

欠損があるということは、休憩、録画の中断、アップロード失敗のいずれかが
起きた可能性を意味します。どれが起きたかはログからは断定できません。
断定せず、欠損として扱ってください。

## 30秒ごとの観察ログ（時刻順）
{json.dumps(compact, ensure_ascii=False, indent=1)}

## 出力形式
次のJSON schemaに厳密に従ってください:
{OUTPUT_SCHEMA}

JSONのみを出力してください。"""
