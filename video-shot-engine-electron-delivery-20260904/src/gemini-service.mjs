import { GoogleGenAI } from "@google/genai";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function extractInteractionText(interaction) {
  if (typeof interaction?.streamedOutputText === "string") return interaction.streamedOutputText;
  const candidates = [interaction?.outputs, interaction?.steps?.at?.(-1)?.content, interaction?.output];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const stack = Array.isArray(candidate) ? [...candidate] : [candidate];
    while (stack.length) {
      const value = stack.shift();
      if (!value || typeof value !== "object") continue;
      if (typeof value.text === "string") return value.text;
      for (const child of Object.values(value)) if (child && typeof child === "object") stack.push(child);
    }
  }
  throw new Error("Gemini 响应中没有找到文本输出");
}

export function createGeminiService({ apiKey, model, pollMs = 5000 }) {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async uploadVideo(filePath, displayName, mimeType) {
      return ai.files.upload({ file: filePath, config: { displayName, mimeType } });
    },
    async waitForFile(name, onState) {
      while (true) {
        const file = await ai.files.get({ name });
        await onState?.(file);
        if (file.state === "ACTIVE") return file;
        if (file.state === "FAILED") throw new Error("Gemini 视频预处理失败");
        await sleep(pollMs);
      }
    },
    async analyze(fileUri, profile, onEvent) {
      const stream = await ai.interactions.create({
        model,
        stream: true,
        store: true,
        input: [
          { type: "video", uri: fileUri, ...profile.videoOptions },
          { type: "text", text: profile.prompt },
        ],
        response_format: { type: "text", mime_type: "application/json", schema: profile.schema },
      }, { timeout: 600000, maxRetries: 0 });
      let interaction = null;
      let interactionId = null;
      let outputText = "";
      for await (const rawEvent of stream) {
        const event = rawEvent?.data || rawEvent;
        await onEvent?.(event);
        if (event?.interaction?.id) interactionId = event.interaction.id;
        if (event?.event_type === "interaction.completed") interaction = event.interaction;
        if (event?.event_type === "step.delta" && event.delta?.type === "text") outputText += event.delta.text || "";
        if (event?.event_type === "error") throw new Error(event.error?.message || "Gemini 流式分析失败");
      }
      if (!outputText && interaction) outputText = extractInteractionText(interaction);
      if (!outputText) throw new Error("Gemini 分析完成但没有文本输出");
      return {
        interaction: { ...(interaction || {}), id: interaction?.id || interactionId, streamedOutputText: outputText },
        parsed: JSON.parse(outputText),
        usage: interaction?.usage || null,
      };
    },
  };
}
