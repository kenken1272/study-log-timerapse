"""Prompt construction for the per-chunk vision model."""

from __future__ import annotations

SYSTEM_PROMPT = """あなたは学習セッションの映像から観察できる事実だけを報告する分析器です。

厳守事項:
- 映像に実際に写っているものだけを述べる。推測で行動や理由を作らない。
- 個人の識別、顔認識、感情の断定を行わない。
- 集中度は心理状態の測定値ではなく、着席の継続、手や視線の動き、
  スマートフォン操作、離席など観察可能な手掛かりからの推定値である。
- 判断材料が乏しい場合は confidence を下げ、presence や primary_activity に
  unclear を使う。無理に断定しない。
- 出力はJSONオブジェクトのみ。前置き、説明、コードフェンスを付けない。
"""

USER_TEMPLATE = """これは学習セッションの録画から抽出した連続する{frame_count}枚の静止画です。
それぞれチャンク開始からの経過秒数は次のとおりです: {offsets}

チャンク全体の長さは約{duration:.1f}秒です。
時系列順に変化を観察し、次のJSON schemaで回答してください。

{{
  "concentration_score": 0-100の整数,
  "concentration_level": "high" | "medium" | "low" | "unknown",
  "presence": "present" | "absent" | "unclear",
  "primary_activity": "writing" | "reading" | "typing" | "phone" | "talking" | "idle" | "away" | "unclear",
  "phone_use": true | false,
  "away_from_desk": true | false,
  "posture_change_count": 0以上の整数,
  "confidence": 0.0-1.0の小数,
  "status_summary": "観察できた内容だけを日本語1-2文で",
  "evidence_offsets_seconds": [根拠となったフレームの経過秒数]
}}

JSONのみを出力してください。"""


def build_user_prompt(offsets_seconds: list[float], duration_seconds: float) -> str:
    offsets = ", ".join(f"{value:.2f}秒" for value in offsets_seconds)
    return USER_TEMPLATE.format(
        frame_count=len(offsets_seconds),
        offsets=offsets,
        duration=duration_seconds,
    )


def build_messages(offsets_seconds: list[float], duration_seconds: float) -> list[dict]:
    """Chat messages with one image placeholder per sampled frame."""
    content: list[dict] = [{"type": "image"} for _ in offsets_seconds]
    content.append(
        {"type": "text", "text": build_user_prompt(offsets_seconds, duration_seconds)}
    )
    return [
        {"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]},
        {"role": "user", "content": content},
    ]
