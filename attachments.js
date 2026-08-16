// Aura AI — attachments.js
// Server-side validation for image/document attachments sent with a chat
// message. Treats every uploaded file as untrusted input: validates by
// inspecting actual file bytes (magic numbers), not just the client-
// supplied MIME type or filename extension, which a malicious or buggy
// client could lie about.

const MAX_FILES_PER_MESSAGE = 3;

// Per-category size limits, in bytes. Images stay small since vision
// models don't benefit from huge resolution; documents get more headroom
// since a real PDF can legitimately run several MB.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // 8MB
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024; // 15MB

// Gemini's inline_data path caps total request size around 20MB — this is
// the aggregate ceiling across every attachment in one message, checked
// in addition to the per-file limits above.
const MAX_TOTAL_REQUEST_BYTES = 18 * 1024 * 1024;

// Supported now: images (native Gemini vision) and PDF/TXT (native Gemini
// document understanding via inline_data). DOCX is deliberately NOT
// included — direct testing against the real Gemini API (corroborated by
// multiple independent bug reports) shows generateContent rejects
// application/vnd.openxmlformats-officedocument.wordprocessingml.document
// with "Unsupported MIME type." Claiming DOCX support here would mean
// silently failing every DOCX upload with an opaque provider error instead
// of a clear one, so it's rejected up front with an honest message.
const SUPPORTED_TYPES = {
  'image/png':  { category: 'image', extensions: ['.png'] },
  'image/jpeg': { category: 'image', extensions: ['.jpg', '.jpeg'] },
  'image/webp': { category: 'image', extensions: ['.webp'] },
  'application/pdf': { category: 'document', extensions: ['.pdf'] },
  'text/plain': { category: 'document', extensions: ['.txt'] },
  // CSV/TSV are plain text (no magic bytes) — detected by structure: a
  // header line with consistent delimiter counts. Served to the model as
  // text; parsed deterministically by the research Data Analyst Agent.
  'text/csv': { category: 'document', extensions: ['.csv', '.tsv'] },
};

// Magic-byte signatures for the types above. This is the actual security
// boundary — a client can claim any Content-Type it likes, but it can't
// change what the first few bytes of a real file of that type look like.
// TXT has no reliable magic number (it's arbitrary text), so it's
// verified differently below: by confirming the decoded bytes don't
// contain control/binary characters that a real text file wouldn't have.
function detectRealType(buffer) {
  if (buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 3 &&
      buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp'; // RIFF....WEBP
  }
  if (buffer.length >= 5 &&
      buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46 && buffer[4] === 0x2D) {
    return 'application/pdf'; // %PDF-
  }
  // Not one of the known binary signatures — check if it looks like
  // plausible plain text (used for the TXT case; also lets us positively
  // reject anything binary-but-unrecognized, e.g. a renamed .docx/.exe).
  if (looksLikePlainText(buffer)) return 'text/plain';
  return null;
}

function looksLikePlainText(buffer) {
  if (buffer.length === 0) return false;
  const sampleLen = Math.min(buffer.length, 4096);
  let suspicious = 0;
  for (let i = 0; i < sampleLen; i++) {
    const byte = buffer[i];
    // Allow common whitespace (tab, LF, CR) and printable ASCII / UTF-8
    // continuation bytes; count anything else (null bytes, most control
    // characters) as a sign this isn't plain text.
    const isCommonWhitespace = byte === 9 || byte === 10 || byte === 13;
    const isPrintableAscii = byte >= 32 && byte <= 126;
    const isUtf8Continuation = byte >= 128;
    if (!isCommonWhitespace && !isPrintableAscii && !isUtf8Continuation) {
      suspicious++;
    }
  }
  return suspicious / sampleLen < 0.01; // allow a tiny margin for stray bytes
}

function extensionMatches(filename, expectedExtensions) {
  const lower = (filename || '').toLowerCase();
  return expectedExtensions.some(ext => lower.endsWith(ext));
}

class AttachmentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}

// Validates one attachment object as received from the frontend:
//   { filename: string, mimeType: string (client-claimed), dataBase64: string }
// Returns { mimeType (server-verified), category, buffer, filename } on
// success, or throws AttachmentError with a clean, user-facing message.
function validateAttachment(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new AttachmentError('Invalid attachment.', 'INVALID_ATTACHMENT');
  }
  const { filename, mimeType: claimedMimeType, dataBase64 } = raw;

  if (typeof dataBase64 !== 'string' || !dataBase64) {
    throw new AttachmentError('Attachment data is missing.', 'INVALID_ATTACHMENT');
  }

  let buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    throw new AttachmentError('Attachment data could not be decoded.', 'INVALID_ATTACHMENT');
  }
  if (buffer.length === 0) {
    throw new AttachmentError('Attachment appears to be empty.', 'INVALID_ATTACHMENT');
  }

  // Never trust the client-provided MIME type alone — verify by content.
  let realType = detectRealType(buffer);
  if (!realType || !SUPPORTED_TYPES[realType]) {
    throw new AttachmentError(
      `"${filename || 'file'}" isn't a supported file type. Aura AI currently supports PNG, JPG, WEBP, PDF, TXT, and CSV files.`,
      'UNSUPPORTED_TYPE'
    );
  }

  // CSV/TSV: plain text with no magic bytes, so the filename extension is
  // the distinguishing signal — a structurally tabular .csv/.tsv becomes
  // text/csv (category document); anything else stays text/plain. The
  // research Data Analyst Agent picks datasets up by this classification.
  if (realType === 'text/plain' && /\.(csv|tsv)$/i.test(filename || '')) {
    const sample = buffer.subarray(0, 4096).toString('utf8');
    const lines = sample.split(/\r?\n/).filter(l => l.trim()).slice(0, 4);
    const structural = lines.length >= 2 && [',', ';', '\t'].some(delim => {
      const counts = lines.map(l => l.split(delim).length - 1);
      return counts.every(c => c === counts[0] && c >= 1);
    });
    if (structural) realType = 'text/csv';
    else {
      throw new AttachmentError(
        `"${filename || 'file'}" doesn't look like a valid CSV/TSV table.`,
        'TYPE_MISMATCH'
      );
    }
  }

  const spec = SUPPORTED_TYPES[realType];

  // Cross-check: does the claimed MIME type and filename extension
  // roughly agree with what the bytes actually are? A mismatch isn't
  // automatically fatal (browsers are inconsistent about MIME types for
  // some formats), but wildly wrong claims are rejected as suspicious.
  if (claimedMimeType && SUPPORTED_TYPES[claimedMimeType] && SUPPORTED_TYPES[claimedMimeType].category !== spec.category) {
    throw new AttachmentError(
      `"${filename || 'file'}" doesn't match the file type it claims to be.`,
      'TYPE_MISMATCH'
    );
  }
  if (filename && !extensionMatches(filename, spec.extensions)) {
    throw new AttachmentError(
      `"${filename}" doesn't look like a ${spec.extensions[0]} file.`,
      'TYPE_MISMATCH'
    );
  }

  const maxBytes = spec.category === 'image' ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
  if (buffer.length > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    throw new AttachmentError(
      `"${filename || 'file'}" is too large. ${spec.category === 'image' ? 'Images' : 'Documents'} must be under ${maxMb}MB.`,
      'FILE_TOO_LARGE'
    );
  }

  return {
    filename: filename || 'attachment',
    mimeType: realType, // server-verified, never the raw client claim
    category: spec.category,
    buffer,
  };
}

// Validates a whole message's worth of attachments: enforces the 3-file
// cap and the aggregate size ceiling, then validates each one individually.
function validateAttachments(rawAttachments) {
  if (!rawAttachments) return [];
  if (!Array.isArray(rawAttachments)) {
    throw new AttachmentError('Attachments must be a list.', 'INVALID_ATTACHMENT');
  }
  if (rawAttachments.length > MAX_FILES_PER_MESSAGE) {
    throw new AttachmentError(
      `You can attach up to ${MAX_FILES_PER_MESSAGE} files per message.`,
      'TOO_MANY_FILES'
    );
  }

  const validated = rawAttachments.map(validateAttachment);

  const totalBytes = validated.reduce((sum, a) => sum + a.buffer.length, 0);
  if (totalBytes > MAX_TOTAL_REQUEST_BYTES) {
    throw new AttachmentError(
      'These files are too large together. Try attaching fewer or smaller files.',
      'TOTAL_TOO_LARGE'
    );
  }

  return validated;
}

module.exports = {
  AttachmentError,
  MAX_FILES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_DOCUMENT_BYTES,
  SUPPORTED_TYPES,
  validateAttachment,
  validateAttachments,
};
