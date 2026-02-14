import { ApiProperty } from '@nestjs/swagger';

export class CollaboratorDto {
  @ApiProperty({ description: '협업자 레코드 ID' })
  id: string;

  @ApiProperty({ description: '초대된 이메일' })
  inviteeEmail: string;

  @ApiProperty({ description: '역할 (VIEWER)', example: 'VIEWER' })
  role: string;

  @ApiProperty({
    description: '상태 (PENDING | ACCEPTED)',
    example: 'ACCEPTED',
  })
  status: string;

  @ApiProperty({ description: '초대일시' })
  createdAt: Date;
}
