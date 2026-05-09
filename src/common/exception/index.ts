import { HttpError } from './http-error';

export class BadRequestException extends HttpError {
  constructor(message: string = 'Bad Request') {
    super(400, 'Bad Request', message);
  }
}

export class UnAuthorizedException extends HttpError {
  constructor(message: string = 'Unauthorized') {
    super(401, 'Unauthorized', message);
  }
}

export class ForbiddenException extends HttpError {
  constructor(message: string = 'Forbidden') {
    super(403, 'Forbidden', message);
  }
}

export class ResourceNotFoundException extends HttpError {
  constructor(message: string = 'Resource Not Found') {
    super(404, 'Resource Not Found', message);
  }
}

export class MethodNotAllowedException extends HttpError {
  constructor(message: string = 'Method Not Allowed') {
    super(405, 'Method Not Allowed', message);
  }
}

export class ConflictException extends HttpError {
  constructor(message: string = 'Conflict') {
    super(409, 'Conflict', message);
  }
}

export class InternalServerException extends HttpError {
  constructor(message: string = 'Internal Server Error') {
    super(500, 'Internal Server Error', message);
  }
}

export { HttpError };
