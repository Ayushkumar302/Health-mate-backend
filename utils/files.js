import mongoose from "mongoose";
import { Readable } from "node:stream";

// Uploaded files live in MongoDB (GridFS) instead of the server's disk, so they survive redeploys
// on hosts with temporary disks, and they are never public: every download goes through an access check.

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "documents" });

// trust the file's first bytes, not its name or the browser's claimed type
const SIGNATURES = [
  { mime: "application/pdf", ext: "pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mime: "image/png", ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
];

export const detectFileType = buffer =>
  SIGNATURES.find(signature => signature.bytes.every((byte, index) => buffer[index] === byte)) || null;

// file names end up in a download header, keep them short and plain
export const safeFileName = (name, ext) => {
  const base = String(name || "document")
    .replace(/\.[^.]*$/, "")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .slice(0, 60);
  return `${base || "document"}.${ext}`;
};

export const saveFile = (buffer, { filename, mime }) =>
  new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(filename, { metadata: { mime } });
    Readable.from(buffer).pipe(upload).on("error", reject).on("finish", () => resolve(upload.id));
  });

export const streamFile = (fileId, res) =>
  new Promise((resolve, reject) => {
    bucket().openDownloadStream(fileId).on("error", reject).on("end", resolve).pipe(res);
  });

export const deleteFile = async fileId => {
  try {
    await bucket().delete(fileId);
  } catch {
    // already gone
  }
};
