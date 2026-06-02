import { Module } from '@nestjs/common';
import { UploadModule } from '../upload/upload.module';
import { UploadSessionController } from './upload-session.controller';
import { UploadSessionService } from './upload-session.service';
import { UploadSessionCleanup } from './upload-session.cleanup';

@Module({
  imports: [UploadModule],
  controllers: [UploadSessionController],
  providers: [UploadSessionService, UploadSessionCleanup],
  exports: [UploadSessionService],
})
export class UploadSessionModule {}
