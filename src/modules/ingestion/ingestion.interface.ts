export interface IProcessedEmail {
  id: number;
  emailConnectionId: number;
  gmailMessageId: string;
  processedAt: Date;
  outcome: string;
  transactionId: number | null;
}

export interface ICreateProcessedEmail {
  emailConnectionId: number;
  gmailMessageId: string;
  outcome: 'parsed' | 'non_transaction' | 'failed';
  transactionId?: number;
}
