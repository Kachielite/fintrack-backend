import { inject, injectable } from 'tsyringe';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import jwksClient from 'jwks-rsa';
import { CONSTANTS } from '@/common/configuration/constants';
import {
  BadRequestException,
  InternalServerException,
  UnAuthorizedException,
} from '@/common/exception';
import logger from '@/common/lib/logger';
import { IAuthRepository } from './auth.repository';
import { IUserRepository } from '@/modules/user/user.repository';
import { AuthResponseDTO, GoogleAuthDTO, AppleAuthDTO, RefreshTokenDTO } from './auth.dto';
import { AuthProviderEnum } from './auth.enum';

const appleJwksClient = jwksClient({
  jwksUri: 'https://appleid.apple.com/auth/keys',
});

export interface IAuthService {
  googleAuth(data: GoogleAuthDTO): Promise<AuthResponseDTO>;
  appleAuth(data: AppleAuthDTO): Promise<AuthResponseDTO>;
  refreshToken(data: RefreshTokenDTO): Promise<Pick<AuthResponseDTO, 'access_token'>>;
  logout(userId: number): Promise<void>;
}

@injectable()
class AuthService implements IAuthService {
  private googleClient: OAuth2Client;

  constructor(
    @inject('IAuthRepository') private authRepository: IAuthRepository,
    @inject('IUserRepository') private userRepository: IUserRepository,
  ) {
    this.googleClient = new OAuth2Client();
  }

  async googleAuth(data: GoogleAuthDTO): Promise<AuthResponseDTO> {
    try {
      logger.info('[Auth] Google auth attempt');
      const ticket = await this.googleClient.verifyIdToken({
        idToken: data.id_token,
        audience: [CONSTANTS.GOOGLE_CLIENT_ID, CONSTANTS.GOOGLE_WEB_CLIENT_ID].filter(Boolean),
      });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) {
        throw new BadRequestException('Invalid Google token');
      }

      return await this.upsertUserAndIssueTokens({
        provider: AuthProviderEnum.GOOGLE,
        providerUserId: payload.sub,
        email: payload.email,
        firstName: payload.given_name || payload.name || 'User',
        lastName: payload.family_name,
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      logger.error(`Google auth error - ${error}`);
      throw new InternalServerException('Google authentication failed');
    }
  }

  async appleAuth(data: AppleAuthDTO): Promise<AuthResponseDTO> {
    try {
      logger.info('[Auth] Apple auth attempt');
      const decoded = await this.verifyAppleToken(data.id_token);

      return await this.upsertUserAndIssueTokens({
        provider: AuthProviderEnum.APPLE,
        providerUserId: decoded.sub,
        email: decoded.email,
        firstName: data.first_name || 'User',
        lastName: data.last_name,
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      logger.error(`Apple auth error - ${error}`);
      throw new InternalServerException('Apple authentication failed');
    }
  }

  async refreshToken(data: RefreshTokenDTO): Promise<Pick<AuthResponseDTO, 'access_token'>> {
    try {
      logger.info('[Auth] Refreshing access token');
      const decoded = jwt.verify(data.refresh_token, CONSTANTS.JWT_SECRET) as {
        id: number;
        type: string;
      };
      if (decoded.type !== 'refresh') throw new UnAuthorizedException('Invalid refresh token');

      const user = await this.userRepository.findById(decoded.id);
      if (!user) throw new UnAuthorizedException('User not found');

      const tokenHash = crypto
        .createHash('sha256')
        .update(data.refresh_token)
        .digest('hex');
      if (user.refreshTokenHash !== tokenHash) {
        throw new UnAuthorizedException('Refresh token has been invalidated');
      }

      const accessToken = this.issueAccessToken(user.id, user.email);
      return { access_token: accessToken };
    } catch (error) {
      if (error instanceof UnAuthorizedException) throw error;
      logger.error(`Refresh token error - ${error}`);
      throw new UnAuthorizedException('Invalid or expired refresh token');
    }
  }

  async logout(userId: number): Promise<void> {
    try {
      logger.info(`[Auth] Logging out user ${userId}`);
      await this.userRepository.updateRefreshTokenHash(userId, null);
    } catch (error) {
      logger.error(`Logout error - ${error}`);
      throw new InternalServerException('Logout failed');
    }
  }

  private async verifyAppleToken(idToken: string): Promise<{ sub: string; email: string }> {
    const header = JSON.parse(Buffer.from(idToken.split('.')[0], 'base64').toString());
    const key = await appleJwksClient.getSigningKey(header.kid);
    const publicKey = key.getPublicKey();
    const decoded = jwt.verify(idToken, publicKey, {
      algorithms: ['RS256'],
      issuer: 'https://appleid.apple.com',
      audience: CONSTANTS.APPLE_CLIENT_ID,
    }) as any;
    return { sub: decoded.sub, email: decoded.email };
  }

  private async upsertUserAndIssueTokens(params: {
    provider: AuthProviderEnum;
    providerUserId: string;
    email: string;
    firstName: string;
    lastName?: string;
  }): Promise<AuthResponseDTO> {
    const existing = await this.authRepository.findAuthProvider({
      provider: params.provider,
      providerUserId: params.providerUserId,
    });

    let user;
    if (existing) {
      user = await this.userRepository.findById(existing.userId);
      if (!user) throw new InternalServerException('User record missing');
    } else {
      let existingUser = await this.userRepository.findByEmail(params.email);
      if (!existingUser) {
        existingUser = await this.userRepository.createUser({
          email: params.email,
          firstName: params.firstName,
          lastName: params.lastName,
        });
      }
      await this.authRepository.createAuthProvider({
        userId: existingUser.id,
        provider: params.provider,
        providerUserId: params.providerUserId,
      });
      user = existingUser;
    }

    logger.info(`[Auth] Issued tokens for user ${user.id} (${existing ? 'existing' : 'new'})`);
    const accessToken = this.issueAccessToken(user.id, user.email);
    const refreshToken = this.issueRefreshToken(user.id);
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await this.userRepository.updateRefreshTokenHash(user.id, tokenHash);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.firstName,
        onboarding_complete: user.onboardingComplete,
      },
    };
  }

  private issueAccessToken(userId: number, email: string): string {
    return jwt.sign({ id: userId, email, type: 'access' }, CONSTANTS.JWT_SECRET, {
      expiresIn: CONSTANTS.JWT_EXPIRES_IN,
    } as any);
  }

  private issueRefreshToken(userId: number): string {
    return jwt.sign({ id: userId, type: 'refresh' }, CONSTANTS.JWT_SECRET, {
      expiresIn: CONSTANTS.JWT_REFRESH_EXPIRES_IN,
    } as any);
  }
}

export default AuthService;
