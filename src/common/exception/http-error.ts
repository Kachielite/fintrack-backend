export interface ErrorResponseDTO {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
}

export class HttpError extends Error {
  public statusCode: number;
  public error: string;
  public code?: string;

  constructor(statusCode: number, error: string, message: string, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.error = error;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): ErrorResponseDTO {
    return {
      statusCode: this.statusCode,
      error: this.error,
      message: this.message,
      ...(this.code ? { code: this.code } : {}),
    };
  }
}
