import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CorrespondenceDirection, ItemState } from './correspondence-item.entity';

const DIRECTIONS = ['INCOMING', 'OUTGOING', 'INTERNAL'];

export class CreateDraftDto {
  @IsIn(DIRECTIONS, { message: 'Choose incoming, outgoing or internal.' })
  direction: CorrespondenceDirection;

  @IsString()
  @MinLength(1, { message: 'A subject is required.' })
  @MaxLength(400)
  subject: string;

  @IsOptional() @IsString() @MaxLength(300)
  party?: string;

  @IsOptional() @IsDateString({}, { message: 'The document date must be a valid date.' })
  documentDate?: string;
}

export class UpdateDraftDto extends CreateDraftDto {
  /**
   * The version the client last read. Required: DEC-05 selected the optimistic
   * version check, so an update without a version cannot be accepted at all.
   */
  @IsInt({ message: 'The version you are editing must be supplied.' })
  version: number;
}

export class RegisterDto {
  @IsInt({ message: 'The version you are registering must be supplied.' })
  version: number;
}

export interface ItemView {
  id: string;
  registrationIdentity: string | null;
  state: ItemState;
  direction: CorrespondenceDirection;
  subject: string;
  party: string | null;
  documentDate: string | null;
  registeredAt: string | null;
  createdAt: string;
  version: number;
  createdByName: string;
  owningUnit: string | null;
}

export class ItemIdDto {
  @IsUUID('4', { message: 'A valid item identifier is required.' })
  id: string;
}
