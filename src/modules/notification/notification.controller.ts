import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import {
  BaseController,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
} from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import NotificationService, { INotificationService } from './notification.service';
import { IAuthenticatedRequest } from '@/common/types/interface';

@injectable()
@Controller('/notifications')
class NotificationController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.NOTIFICATION) router: express.Router,
    @inject(NotificationService) private readonly service: INotificationService,
  ) {
    super(router);
  }

  @Get('/')
  async list(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return this.service.list(userId);
  }

  @Get('/unread-count')
  async unreadCount(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return this.service.getUnreadCount(userId);
  }

  @Patch('/:id/read')
  async markRead(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    await this.service.markRead(id, userId);
    return { success: true };
  }

  @Patch('/read-all')
  async markAllRead(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    await this.service.markAllRead(userId);
    return { success: true };
  }

  @Post('/device-token')
  async registerDeviceToken(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const { player_id, platform } = req.body as { player_id: string; platform?: string };
    return this.service.registerDeviceToken(userId, player_id, platform);
  }

  @Delete('/device-token/:playerId')
  async removeDeviceToken(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const playerId = req.params.playerId as string;
    return this.service.removeDeviceToken(userId, playerId);
  }
}

export default NotificationController;
