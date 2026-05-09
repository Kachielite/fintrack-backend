import { AuthProviderEnum } from './auth.enum';

export interface IAuthProvider {
  id: number;
  userId: number;
  provider: AuthProviderEnum;
  providerUserId: string;
  createdAt: Date;
}

export interface ICreateAuthProvider {
  userId: number;
  provider: AuthProviderEnum;
  providerUserId: string;
}

export interface IFindAuthProvider {
  provider: AuthProviderEnum;
  providerUserId: string;
}
