export interface IBank {
  id: number;
  name: string;
  shortCode: string;
  country: string | null;
  knownSenderEmails: string[];
  logoUrl: string | null;
  isActive: boolean;
  createdAt: Date;
}
