import test from "node:test";
import assert from "node:assert/strict";
import { statusLabel, isAudioDonation, audioUrl } from "./labels.ts";

test("statusLabel maps known states and passes through unknowns", () => {
  assert.equal(statusLabel("connected"), "подключено");
  assert.equal(statusLabel("ENABLED"), "включено");
  assert.equal(statusLabel(""), "");
  assert.equal(statusLabel(null), "");
  assert.equal(statusLabel("custom"), "custom");
});

test("isAudioDonation detects message_type and media URLs", () => {
  assert.equal(isAudioDonation({ messageType: "audio" }), true);
  assert.equal(
    isAudioDonation({ text: "https://cdn.example/a.wav" }),
    true,
  );
  assert.equal(isAudioDonation({ text: "hello" }), false);
  assert.equal(isAudioDonation({}), false);
});

test("audio suffix fallback requires HTTP after a WAV query marker",()=>{
  assert.equal(isAudioDonation({text:"https://cdn.example/alert.wav?token=x space"}),true);
  assert.equal(isAudioDonation({text:"ftp://cdn.example/alert.wav?token=x space"}),false);
  assert.equal(isAudioDonation({text:"https://cdn.example/alert.wav#player"}),false);
});

test("audioUrl returns http(s) text only", () => {
  assert.equal(audioUrl({ text: "https://x/a.mp3" }), "https://x/a.mp3");
  assert.equal(audioUrl({ text: "not-url" }), null);
  assert.equal(audioUrl({}), null);
});
