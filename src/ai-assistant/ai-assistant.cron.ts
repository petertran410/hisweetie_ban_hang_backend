import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AiChatService } from './ai-chat.service';

/** 6 giờ một lần: xoá hội thoại trợ lý AI quá thời hạn lưu (AI_CHAT_RETENTION_DAYS). */
@Injectable()
export class AiAssistantCron {
  private readonly logger = new Logger(AiAssistantCron.name);
  private running = false;

  constructor(private readonly chat: AiChatService) {}

  @Cron('17 */6 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async purge() {
    if (this.running || !this.chat.config.enabled) return;
    this.running = true;
    try {
      const { conversations, messages } = await this.chat.purgeExpired();
      if (conversations || messages)
        this.logger.log(
          `Xoá ${conversations} hội thoại, ${messages} tin trợ lý AI quá hạn`,
        );
    } catch (e) {
      this.logger.error(`Dọn hội thoại trợ lý AI lỗi: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
