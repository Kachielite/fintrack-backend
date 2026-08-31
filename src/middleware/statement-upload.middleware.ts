import multer, { MulterError } from 'multer';
import { Request, Response, NextFunction } from 'express';
import { BadRequestException } from '@/common/exception';

// 20MB comfortably covers multi-year CSV/Excel exports and scanned-text PDFs
// without leaving the process open to being memory-bombed by a single request.
export const STATEMENT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

// .xls/.doc are accepted here (so the service layer can give a specific,
// actionable "convert to .xlsx/.docx" message) even though they aren't
// parseable yet — see TransactionService.detectStatementFormat.
const ALLOWED_EXTENSIONS = new Set(['csv', 'xlsx', 'xls', 'pdf', 'docx', 'doc']);

const ALLOWED_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

function extensionOf(filename: string): string | undefined {
  return filename.split('.').pop()?.toLowerCase();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: STATEMENT_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = extensionOf(file.originalname);
    if (ALLOWED_MIME_TYPES.has(file.mimetype) || (ext && ALLOWED_EXTENSIONS.has(ext))) {
      cb(null, true);
      return;
    }
    cb(
      new BadRequestException(
        `Unsupported file type "${file.mimetype || ext || 'unknown'}". Supported formats: CSV, Excel (.xlsx/.xls), PDF, and Word (.docx).`,
      ),
    );
  },
});

/**
 * Wraps multer's single-file upload so its errors (oversized file, rejected
 * type) surface as BadRequestException instead of an unhandled error that
 * would otherwise fall through to a generic 500.
 */
export function statementUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
      next(
        new BadRequestException(
          `File is too large. Maximum upload size is ${STATEMENT_UPLOAD_MAX_BYTES / (1024 * 1024)}MB.`,
        ),
      );
      return;
    }
    if (err instanceof BadRequestException) {
      next(err);
      return;
    }
    next(new BadRequestException('Could not process the uploaded file.'));
  });
}
