export interface ITransferLink {
  id: number;
  userId: number;
  fromTransactionId: number | null;
  toTransactionId: number | null;
  linkType: string;
  confidence: string;
  createdAt: Date;
}
