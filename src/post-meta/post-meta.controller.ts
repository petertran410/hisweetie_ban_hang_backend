import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { PostMetaService } from './post-meta.service';
import { CreatePostMetaDto, UpdatePostMetaDto } from './dto';

@Controller('post-meta')
export class PostMetaController {
  constructor(private postMetaService: PostMetaService) {}

  @Get('post/:postId')
  findAllByPost(@Param('postId') postId: string) {
    return this.postMetaService.findAllByPost(+postId);
  }

  @Get('post/:postId/:metaKey')
  findOne(@Param('postId') postId: string, @Param('metaKey') metaKey: string) {
    return this.postMetaService.findOne(+postId, metaKey);
  }

  @Post()
  create(@Body() dto: CreatePostMetaDto) {
    return this.postMetaService.create(dto);
  }

  @Put('post/:postId/:metaKey')
  update(
    @Param('postId') postId: string,
    @Param('metaKey') metaKey: string,
    @Body() dto: UpdatePostMetaDto,
  ) {
    return this.postMetaService.update(+postId, metaKey, dto);
  }

  @Delete('post/:postId/:metaKey')
  remove(@Param('postId') postId: string, @Param('metaKey') metaKey: string) {
    return this.postMetaService.remove(+postId, metaKey);
  }
}
