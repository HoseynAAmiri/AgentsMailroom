import assert from "node:assert/strict";
import test from "node:test";
import type * as ApiModule from "./api";

const {
  attachmentDownloadHref,
  attachmentHref,
  fileCategory,
  fileExtension,
  fileHref,
  fileKind,
} = (await import(new URL("./api.ts", import.meta.url).href)) as typeof ApiModule;

test("fileExtension extracts lowercase extension and skips dotless or hidden names", () => {
  assert.equal(fileExtension("report.PDF"), "pdf");
  assert.equal(fileExtension("sub/dir/notes.md"), "md");
  assert.equal(fileExtension("README"), "");
  assert.equal(fileExtension(".hidden"), "");
});

test("fileKind classifies images, pdf, markdown, json, audio, video, text, and binaries", () => {
  assert.equal(fileKind("plot.PNG"), "image");
  assert.equal(fileKind("photo.avif"), "image");
  assert.equal(fileKind("paper.pdf"), "pdf");
  assert.equal(fileKind("summary.md"), "markdown");
  assert.equal(fileKind("metrics.jsonl"), "json");
  assert.equal(fileKind("notes.txt"), "text");
  assert.equal(fileKind("README"), "text");
  assert.equal(fileKind("sound.mp3"), "audio");
  assert.equal(fileKind("clip.mp4"), "video");
  assert.equal(fileKind("archive.zip"), "binary");
  assert.equal(fileKind("manuscript.docx"), "binary");
  assert.equal(fileKind("mesh.msh"), "binary");
});

test("fileCategory groups attachments into Images, PDFs, Text, Data & code, and Other", () => {
  assert.equal(fileCategory("plot.png"), "image");
  assert.equal(fileCategory("report.pdf"), "pdf");
  assert.equal(fileCategory("notes.md"), "text");
  assert.equal(fileCategory("readme.txt"), "text");
  assert.equal(fileCategory("draft.docx"), "text");
  assert.equal(fileCategory("README"), "text");
  assert.equal(fileCategory("data.csv"), "data");
  assert.equal(fileCategory("mesh.msh"), "data");
  assert.equal(fileCategory("run.py"), "data");
  assert.equal(fileCategory("sheet.xlsx"), "data");
  assert.equal(fileCategory("bundle.zip"), "other");
  assert.equal(fileCategory("clip.mp4"), "other");
});

test("attachmentHref, fileHref, and attachmentDownloadHref handle attachments cleanly", () => {
  assert.equal(attachmentHref("coordination/attachments/report%201.pdf"), "/attach/report%25201.pdf");
  assert.equal(attachmentDownloadHref("/attach/archive.zip"), "/attach/archive.zip?download=1");
  assert.equal(attachmentDownloadHref("/attach/archive.zip?v=2"), "/attach/archive.zip?v=2&download=1");
  assert.equal(attachmentDownloadHref("/repo/docs/ok.md"), "/repo/docs/ok.md");
  assert.equal(fileHref("README"), null);
  assert.equal(fileHref("coordination/attachments/README"), "/attach/README");
});
