import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { NoteTemplatesService } from './note-templates.service';
import { CreateNoteTemplateDto, UpdateNoteTemplateDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Note Templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('note-templates')
export class NoteTemplatesController {
  constructor(private noteTemplatesService: NoteTemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'Get all note templates' })
  findAll() {
    return this.noteTemplatesService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get note template by ID' })
  findOne(@Param('id') id: string) {
    return this.noteTemplatesService.findOne(+id);
  }

  @Post()
  @ApiOperation({ summary: 'Create new note template' })
  create(@Body() dto: CreateNoteTemplateDto) {
    return this.noteTemplatesService.create(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update note template' })
  update(@Param('id') id: string, @Body() dto: UpdateNoteTemplateDto) {
    return this.noteTemplatesService.update(+id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete note template' })
  remove(@Param('id') id: string) {
    return this.noteTemplatesService.remove(+id);
  }
}
