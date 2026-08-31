import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import {
  BaseController,
  Controller,
  Post,
} from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import AuthService, { IAuthService } from './auth.service';
import {
  GoogleAuthSchema,
  AppleAuthSchema,
  RefreshTokenSchema,
  LoginSchema,
  RegisterSchema,
  GoogleAuthDTO,
  AppleAuthDTO,
  RefreshTokenDTO,
  LoginDTO,
  RegisterDTO,
} from './auth.dto';
import { IAuthenticatedRequest } from '@/common/types/interface';

@injectable()
@Controller('/auth')
class AuthController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.AUTH) router: express.Router,
    @inject(AuthService) private readonly authService: IAuthService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /auth/google:
   *   post:
   *     tags: [Auth]
   *     summary: Sign in with Google
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [id_token]
   *             properties:
   *               id_token:
   *                 type: string
   *                 example: eyJhbGciOiJSUzI1NiJ9...
   *               terms_accepted:
   *                 type: boolean
   *                 description: Required and must be `true` only on first-time sign-in, when this call creates a brand-new account. Ignored for a returning user, who has already consented.
   *                 example: true
   *     responses:
   *       '200':
   *         description: Auth tokens and user info
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AuthResponse'
   *       '400':
   *         description: Invalid Google token, or a first-time sign-in missing terms_accepted
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/google', { validate: GoogleAuthSchema })
  async googleAuth(req: Request) {
    return await this.authService.googleAuth(req.body as GoogleAuthDTO);
  }

  /**
   * @swagger
   * /auth/apple:
   *   post:
   *     tags: [Auth]
   *     summary: Sign in with Apple
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [id_token]
   *             properties:
   *               id_token:
   *                 type: string
   *                 example: eyJhbGciOiJSUzI1NiJ9...
   *               first_name:
   *                 type: string
   *                 example: Jane
   *               last_name:
   *                 type: string
   *                 example: Doe
   *               terms_accepted:
   *                 type: boolean
   *                 description: Required and must be `true` only on first-time sign-in, when this call creates a brand-new account. Ignored for a returning user, who has already consented.
   *                 example: true
   *     responses:
   *       '200':
   *         description: Auth tokens and user info
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AuthResponse'
   *       '400':
   *         description: Invalid Apple token, or a first-time sign-in missing terms_accepted
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/apple', { validate: AppleAuthSchema })
  async appleAuth(req: Request) {
    return await this.authService.appleAuth(req.body as AppleAuthDTO);
  }

  /**
   * @swagger
   * /auth/login:
   *   post:
   *     tags: [Auth]
   *     summary: Sign in with email and password
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password]
   *             properties:
   *               email:
   *                 type: string
   *                 example: jane@example.com
   *               password:
   *                 type: string
   *                 example: Sup3rSecret!
   *     responses:
   *       '200':
   *         description: Auth tokens and user info
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AuthResponse'
   *       '400':
   *         $ref: '#/components/responses/BadRequest'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/login', { validate: LoginSchema })
  async login(req: Request) {
    return await this.authService.login(req.body as LoginDTO);
  }

  /**
   * @swagger
   * /auth/register:
   *   post:
   *     tags: [Auth]
   *     summary: Create an account with email and password
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password, first_name, terms_accepted]
   *             properties:
   *               email:
   *                 type: string
   *                 example: jane@example.com
   *               password:
   *                 type: string
   *                 example: Sup3rSecret!
   *               first_name:
   *                 type: string
   *                 example: Jane
   *               last_name:
   *                 type: string
   *                 example: Doe
   *               terms_accepted:
   *                 type: boolean
   *                 description: Must be `true` — the request is rejected otherwise. Recorded server-side as proof of consent.
   *                 example: true
   *     responses:
   *       '200':
   *         description: Auth tokens and user info
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AuthResponse'
   *       '400':
   *         description: Validation error, including a missing or false `terms_accepted`
   *       '409':
   *         description: Email already registered
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/register', { validate: RegisterSchema })
  async register(req: Request) {
    return await this.authService.register(req.body as RegisterDTO);
  }

  /**
   * @swagger
   * /auth/refresh:
   *   post:
   *     tags: [Auth]
   *     summary: Refresh access token
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [refresh_token]
   *             properties:
   *               refresh_token:
   *                 type: string
   *                 example: eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.def456
   *     responses:
   *       '200':
   *         description: New access token
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/TokenRefreshResponse'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/refresh', { validate: RefreshTokenSchema })
  async refresh(req: Request) {
    return await this.authService.refreshToken(req.body as RefreshTokenDTO);
  }

  /**
   * @swagger
   * /auth/logout:
   *   post:
   *     tags: [Auth]
   *     summary: Logout and invalidate refresh token
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Logged out successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SuccessResponse'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/logout')
  async logout(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    await this.authService.logout(userId);
    return { success: true, message: 'Logged out successfully', data: null };
  }
}

export default AuthController;
