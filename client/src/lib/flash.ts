// One-shot message handed from one page to the next (e.g. "transcription started").
let message: { kind: 'info' | 'warning' | 'error' | 'success'; text: string } | null = null;
export const setFlash = (kind: 'info' | 'warning' | 'error' | 'success', text: string) => {
  message = { kind, text };
};
export const takeFlash = () => {
  const value = message;
  message = null;
  return value;
};
