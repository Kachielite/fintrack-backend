export interface ErrorResponseDTO {
  statusCode: number;
  error: string;
  message: string;
}

export class HttpError extends Error {
  public statusCode: number;
  public error: string;

  constructor(statusCode: number, error: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.error = error;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): ErrorResponseDTO {
    return {
      statusCode: this.statusCode,
      error: this.error,
      message: this.message,
    };
  }
}
