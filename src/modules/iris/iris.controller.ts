import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import { BaseController, Controller, Delete, Get, Post } from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import IrisService, { IIrisService } from './iris.service';
import { SendMessageSchema, SendMessageDTO } from './iris.dto';
import { IAuthenticatedRequest } from '@/common/types/interface';

@injectable()
@Controller('/iris')
class IrisController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.IRIS) router: express.Router,
    @inject(IrisService) private readonly service: IIrisService,
  ) {
    super(router);
  }

  @Get('/status')
  async getStatus(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.getStatus(userId);
  }

  @Post('/initialize', { statusCode: 202 })
  async initialize(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    await this.service.initialize(userId);
    return { message: 'Initialization started' };
  }

  @Post('/sessions', { statusCode: 201 })
  async createSession(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.createSession(userId);
  }

  @Get('/sessions')
  async listSessions(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.listSessions(userId);
  }

  @Delete('/sessions/:id')
  async deleteSession(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    await this.service.deleteSession(id, userId);
    return { message: 'Session deleted' };
  }

  @Get('/sessions/:id/messages')
  async getMessages(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const sessionId = parseInt(req.params.id as string, 10);
    return await this.service.getMessages(sessionId, userId);
  }

  @Post('/sessions/:id/messages', { validate: { body: SendMessageSchema } })
  async sendMessage(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const sessionId = parseInt(req.params.id as string, 10);
    return await this.service.sendMessage(sessionId, userId, req.body as SendMessageDTO);
  }

  @Get('/suggestions')
  async getSuggestions(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const suggestions = await this.service.getSuggestions(userId);
    return { suggestions };
  }
}

export default IrisController;
