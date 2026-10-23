import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export type ChartClick = { name: string; seriesId?: string };

export function Chart({
  option,
  height = 260,
  onClick,
}: {
  option: echarts.EChartsCoreOption;
  height?: number;
  onClick?: (e: ChartClick) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    const c = echarts.init(el.current!);
    chart.current = c;
    c.on('click', (p) => clickRef.current?.({ name: p.name, seriesId: p.seriesId ?? undefined }));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current!);
    return () => {
      ro.disconnect();
      c.dispose();
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: false, lazyUpdate: true });
  }, [option]);

  return <div ref={el} style={{ height, width: '100%' }} />;
}
