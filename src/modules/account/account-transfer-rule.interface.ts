export type TransferRuleDecision = 'always_transfer' | 'never_transfer';

export interface IAccountTransferRule {
  id: number;
  userId: number;
  accountAId: number;
  accountBId: number;
  decision: TransferRuleDecision;
  createdAt: Date;
  updatedAt: Date;
}
