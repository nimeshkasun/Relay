import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators';
import { GatewayService } from './gateway.service';

/**
 * The single public surface of Relay: an OpenAI-compatible API under /v1,
 * authenticated with Relay API keys (Authorization: Bearer rly_...).
 * Any OpenAI SDK works by pointing its base URL at https://<relay-host>/v1.
 */
@Public()
@Controller('v1')
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  @Post('chat/completions')
  async chat(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    const kc = await this.gateway.authenticate(req);
    await this.gateway.chat(kc, body, req, res);
  }

  /** Anthropic Messages API (native passthrough to Anthropic models). Anthropic SDKs work with base URL https://<relay-host> and api key rly_... */
  @Post('messages')
  async messages(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    const kc = await this.gateway.authenticate(req);
    await this.gateway.messages(kc, body, req, res);
  }

  @Post('embeddings')
  async embeddings(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    const kc = await this.gateway.authenticate(req);
    await this.gateway.embeddings(kc, body, res);
  }

  @Post('batch')
  @HttpCode(200)
  async batch(@Req() req: Request, @Body() body: unknown) {
    const kc = await this.gateway.authenticate(req);
    return this.gateway.batch(kc, body);
  }

  @Get('models')
  async models(@Req() req: Request) {
    const kc = await this.gateway.authenticate(req);
    return this.gateway.listModels(kc);
  }
}
