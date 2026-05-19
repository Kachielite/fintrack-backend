export interface IIrisSession {
  id: number;
  userId: number;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IChartDataPoint {
  label: string;
  value: number;
  highlight: boolean;
}

export interface IChartData {
  type: 'bar_by_category' | 'bar_by_merchant' | 'line_over_time' | 'pie_by_category' | 'pie_by_merchant';
  data: IChartDataPoint[];
}

export interface IIrisMessage {
  id: number;
  sessionId: number;
  role: string;
  content: string;
  chartData: IChartData | null;
  createdAt: Date;
}
