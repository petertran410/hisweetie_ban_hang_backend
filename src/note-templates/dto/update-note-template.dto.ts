import { PartialType } from '@nestjs/mapped-types';
import { CreateNoteTemplateDto } from './create-note-template.dto';

export class UpdateNoteTemplateDto extends PartialType(CreateNoteTemplateDto) {}
