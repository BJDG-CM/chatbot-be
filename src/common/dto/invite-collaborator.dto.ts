import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class InviteCollaboratorDto {
  @ApiProperty({
    description: '초대할 협업자 이메일',
    example: 'collaborator@gistory.me',
  })
  @IsEmail()
  @IsNotEmpty()
  inviteeEmail: string;
}
