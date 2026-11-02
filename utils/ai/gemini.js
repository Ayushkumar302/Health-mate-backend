// Google Gemini, asked for answers in a fixed JSON shape. Shared by the symptom checker, the
// prescription explainer and the doctors' pre-visit summary. The key stays on the server
// (GEMINI_API_KEY); every feature has a non-AI fallback for when it's missing, busy or out of quota.

const API = "https://generativelanguage.googleapis.com/v1beta/models";

// tried in order: the fast one first; when it fails, or is still busy after HEDGE_MS (the free tier
// queues requests at busy times), the next one is asked too and the first good answer wins
const DEFAULT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
const HEDGE_MS = 5000;
// after this the caller's fallback answers instead
const TOTAL_MS = 15000;

export const geminiEnabled = () => Boolean(process.env.GEMINI_API_KEY);

const models = () => {
  const list = (process.env.GEMINI_MODELS || "")
    .split(",")
    .map(name => name.trim())
    .filter(name => /^[\w.-]+$/.test(name));
  return list.length ? list : DEFAULT_MODELS;
};

// text from people (symptoms, report titles...) is wrapped in quotes; this keeps it from closing them early
export const quoted = text => `"""\n${String(text).replace(/"{2,}/g, '"')}\n"""`;

const askModel = async (model, { system, prompt, schema }, signal) => {
  const res = await fetch(`${API}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, maxOutputTokens: 4096 },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${model} ${res.status} ${body.error?.status || ""}`);
  const text = body.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("");
  if (!text) throw new Error(`Gemini ${model} gave no answer (${body.candidates?.[0]?.finishReason || "blocked"})`);
  return JSON.parse(text);
};

// { model, answer } with the raw answer (still to be checked by the caller), or rejects when no model answered in time
export const generateJson = request =>
  new Promise((resolve, reject) => {
    const list = models();
    const controller = new AbortController();
    let started = 0;
    let failed = 0;
    let done = false;
    let hedgeTimer;

    const finish = (settle, value) => {
      if (done) return;
      done = true;
      clearTimeout(hedgeTimer);
      clearTimeout(deadline);
      // stop the requests still running, their answers are no longer needed
      controller.abort();
      settle(value);
    };
    const startNext = () => {
      clearTimeout(hedgeTimer);
      if (done || started >= list.length) return;
      const model = list[started++];
      askModel(model, request, controller.signal)
        .then(answer => finish(resolve, { model, answer }))
        .catch(error => {
          failed++;
          if (failed === list.length) finish(reject, error);
          else startNext();
        });
      hedgeTimer = setTimeout(startNext, HEDGE_MS);
    };
    const deadline = setTimeout(() => finish(reject, new Error("Gemini took too long")), TOTAL_MS);
    startNext();
  });
