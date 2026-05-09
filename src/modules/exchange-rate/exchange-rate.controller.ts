import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import { BaseController, Controller, Get } from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import ExchangeRateService, { IExchangeRateService } from './exchange-rate.service';
import { IAuthenticatedRequest } from '@/common/types/interface';
import { IUserRepository } from '@/modules/user/user.repository';

@injectable()
@Controller('/exchange-rates')
class ExchangeRateController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.EXCHANGE_RATE) router: express.Router,
    @inject(ExchangeRateService) private readonly service: IExchangeRateService,
    @inject('IUserRepository') private readonly userRepository: IUserRepository,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /exchange-rates:
   *   get:
   *     tags: [Exchange Rates]
   *     summary: Get latest FX rates relative to the user's reference currency
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: List of exchange rates
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/ExchangeRate'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/')
  async getLatestRates(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const user = await this.userRepository.findById(userId);
    const refCurrency = user?.refCurrency || 'NGN';
    return await this.service.getLatestRates(refCurrency);
  }
}

export default ExchangeRateController;
