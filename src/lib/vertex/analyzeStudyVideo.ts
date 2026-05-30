import { SchemaType, VertexAI } from "@google-cloud/vertexai";
import { getBucketName } from "@/lib/gcp/storage";
import type { AnalysisResult } from "@/lib/sessions/types";
import { parseAnalysisResult } from "@/lib/vertex/types";

const ANALYSIS_PROMPT = `あなたは勉強記録動画を分析するアシスタントです。

この動画は、ユーザーが勉強している様子をタイムラプス化したものです。
映像から見える行動だけを根拠に、勉強集中度を0〜100で評価してください。

評価基準:

* 机に向かっている時間
* 書く、読む、PC作業などの勉強行動
* 離席時間
* スマホ操作らしき行動
* 寝ている、ぼーっとしている、画面外にいる時間
* 休憩らしき時間

重要な注意:

* 本人の内面、感情、性格、健康状態を断定しない
* 顔、年齢、性別、個人属性を推測しない
* 映像から確認できる行動だけを根拠にする
* 不確実な場合は不確実と書く
* 医療的、心理的な診断をしない
* 必ずJSONだけで返す
* Markdownや説明文をJSONの外に出さない

出力形式:
{
"focusScore": number,
"focusLabel": "かなり低い" | "低い" | "普通" | "高い" | "とても高い",
"studyDetected": boolean,
"estimatedAbsenceMinutes": number,
"estimatedPhoneUseMinutes": number,
"estimatedWritingReadingMinutes": number,
"summary": string,
"evidence": string[],
"uncertainty": string,
"advice": string
}`;

export function getVertexModelName(): string {
  return process.env.VERTEX_MODEL ?? "gemini-2.5-pro";
}

export async function analyzeStudyVideo(
  timelapsePath: string,
): Promise<{ result: AnalysisResult; model: string }> {
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "vla-test1";
  const location = process.env.VERTEX_LOCATION ?? "us-central1";
  const model = getVertexModelName();
  const maxOutputTokens = Number(process.env.ANALYSIS_MAX_OUTPUT_TOKENS ?? 2048);
  const vertexAI = new VertexAI({ project, location });
  const generativeModel = vertexAI.getGenerativeModel({
    model,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: Number.isFinite(maxOutputTokens) ? maxOutputTokens : 2048,
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          focusScore: { type: SchemaType.NUMBER },
          focusLabel: { type: SchemaType.STRING },
          studyDetected: { type: SchemaType.BOOLEAN },
          estimatedAbsenceMinutes: { type: SchemaType.NUMBER },
          estimatedPhoneUseMinutes: { type: SchemaType.NUMBER },
          estimatedWritingReadingMinutes: { type: SchemaType.NUMBER },
          summary: { type: SchemaType.STRING },
          evidence: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
          },
          uncertainty: { type: SchemaType.STRING },
          advice: { type: SchemaType.STRING },
        },
        required: [
          "focusScore",
          "focusLabel",
          "studyDetected",
          "estimatedAbsenceMinutes",
          "estimatedPhoneUseMinutes",
          "estimatedWritingReadingMinutes",
          "summary",
          "evidence",
          "uncertainty",
          "advice",
        ],
      },
    },
  });
  const uri = `gs://${getBucketName()}/${timelapsePath}`;
  const response = await generativeModel.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          {
            fileData: {
              fileUri: uri,
              mimeType: "video/mp4",
            },
          },
          { text: ANALYSIS_PROMPT },
        ],
      },
    ],
  });
  const generated = await response.response;
  const text = generated.candidates?.[0]?.content?.parts
    ?.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
  if (!text) {
    throw new Error("Vertex AI response did not include text.");
  }

  return {
    result: parseAnalysisResult(text),
    model,
  };
}
