import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RegisterAppIdDto {
  @ApiProperty({
    description: '허용할 앱 ID (Android applicationId / iOS bundle identifier)',
    type: String,
    example: 'com.company.myapp',
  })
  @IsString()
  @IsNotEmpty()
  appId: string;
}
