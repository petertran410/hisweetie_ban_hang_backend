import { Module } from '@nestjs/common';
import { NoteTemplatesController } from './note-templates.controller';
import { NoteTemplatesService } from './note-templates.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [NoteTemplatesController],
  providers: [NoteTemplatesService],
  exports: [NoteTemplatesService],
})
export class NoteTemplatesModule {}
