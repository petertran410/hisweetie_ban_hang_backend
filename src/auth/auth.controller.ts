import {
  Controller,
  Post,
  Get,
  Put,
  Body,
  UseGuards,
  Request,
  Req,
  Res,
  Query,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { LarkAuthService } from './lark-auth.service';
import { LarkSetupPasswordDto } from './dto/lark-setup-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Public } from './decorators/public.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private larkAuthService: LarkAuthService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @ApiOperation({ summary: 'Login' })
  login(@Body() data: { email: string; password: string }) {
    return this.authService.login(data.email, data.password);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Get('lark')
  @ApiOperation({ summary: 'Lark OAuth QR login' })
  startLarkLogin(
    @Query('return_to') returnTo: string,
    @Res() res: Response,
  ) {
    const url = this.larkAuthService.buildAuthorizeUrl(returnTo);
    return res.redirect(url);
  }

  @Public()
  @Get('lark/callback')
  @ApiOperation({ summary: 'Lark OAuth callback' })
  async larkCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const url = await this.larkAuthService.handleCallback(code, state);
    return res.redirect(url);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('lark/setup-password')
  @ApiOperation({ summary: 'Set password after first Lark QR login' })
  setupLarkPassword(@Body() data: LarkSetupPasswordDto) {
    return this.larkAuthService.setupPassword(data);
  }

  @Public()
  @SkipThrottle()
  @Post('lark/events')
  @ApiOperation({ summary: 'Lark contact.user.created webhook' })
  handleLarkEvent(@Body() body: Record<string, unknown>) {
    return this.larkAuthService.handleEvent(body);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  @ApiOperation({ summary: 'Register new user' })
  register(
    @Body()
    data: {
      name: string;
      email: string;
      password: string;
      phone?: string;
    },
  ) {
    return this.authService.register(data);
  }

  @Public()
  @Get('google')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Google OAuth login' })
  googleAuth() {}

  @Public()
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Google OAuth callback' })
  async googleAuthCallback(@Req() req, @Res() res: Response) {
    const result = await this.authService.googleLogin(req.user);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(
      `${frontendUrl}/auth/callback?token=${result.accessToken}&user=${encodeURIComponent(JSON.stringify(result.user))}`,
    );
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  async getProfile(@Req() req, @Query('branchId') branchId?: string) {
    const parsedBranchId = branchId ? parseInt(branchId) : undefined;
    return this.authService.getProfile(req.user.id, parsedBranchId);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Put('profile')
  @ApiOperation({ summary: 'Update profile' })
  updateProfile(
    @Request() req,
    @Body() data: { name?: string; phone?: string; avatar?: string },
  ) {
    return this.authService.updateProfile(req.user.id, data);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Put('change-password')
  @ApiOperation({ summary: 'Change password' })
  changePassword(
    @Request() req,
    @Body() data: { oldPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(
      req.user.id,
      data.oldPassword,
      data.newPassword,
    );
  }
}
