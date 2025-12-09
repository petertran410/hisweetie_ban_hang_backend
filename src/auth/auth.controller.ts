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
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Public } from './decorators/public.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Login' })
  login(@Body() data: { email: string; password: string }) {
    return this.authService.login(data.email, data.password);
  }

  @Public()
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

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('profile')
  @ApiOperation({ summary: 'Get current user profile' })
  getProfile(@Request() req) {
    return this.authService.getProfile(req.user.id);
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
