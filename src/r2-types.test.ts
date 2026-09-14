import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const declarations = readFileSync(fileURLToPath(new URL("../types/sproutboat.d.ts", import.meta.url)), "utf8");

test("R2 ambient types include the resumable multipart surface", () => {
  expect(declarations).toContain("interface R2UploadedPart");
  expect(declarations).toContain("interface R2MultipartUpload");
  expect(declarations).toContain("createMultipartUpload(key: string, options?: R2PutOptions): R2MultipartUpload;");
  expect(declarations).toContain("resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;");
});
