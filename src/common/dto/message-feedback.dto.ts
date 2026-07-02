import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty } from 'class-validator';

export enum FeedbackRating {
  GOOD = 'GOOD',
  BAD = 'BAD',
}

export class MessageFeedbackInputDto {
  @ApiProperty({
    description: '답변으로 문제가 해결되었는지 여부',
    enum: FeedbackRating,
    example: FeedbackRating.GOOD,
  })
  @IsEnum(FeedbackRating)
  @IsNotEmpty()
  rating: FeedbackRating;
}

export class MessageFeedbackDto {
  @ApiProperty({
    description: '피드백 대상 assistant 메시지 ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  messageId: string;

  @ApiProperty({
    description: '답변으로 문제가 해결되었는지 여부',
    enum: FeedbackRating,
    example: FeedbackRating.GOOD,
  })
  rating: FeedbackRating;

  @ApiProperty({
    description: '피드백 최초 생성 일시',
    example: '2026-07-03T00:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: '피드백 최종 수정 일시',
    example: '2026-07-03T00:00:00.000Z',
  })
  updatedAt: Date;
}
