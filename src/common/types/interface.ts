import { Request } from 'express';

export interface IAppService {
  start(port: string): void;
}

export interface IGeneralResponse<T> {
  success: boolean;
  message: string;
  data: T;
}

export interface IPagination<T> {
  page: number;
  limit: number;
  total_items: number;
  pages: number;
  items: T[];
}

export interface IAuthenticatedRequest extends Request {
  user?: {
    id: number;
    email: string;
  };
}

export interface IPaginationParams {
  page: number;
  limit: number;
}
