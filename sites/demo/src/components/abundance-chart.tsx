import { barX, defineChart, text } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { useMemo } from "react";
import type { PanelResponse } from "../lib/contract.ts";
import { targetAbundances } from "../lib/display.ts";

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

export function AbundanceChart({ response }: { readonly response: PanelResponse }) {
  const { definition, label, count } = useMemo(() => {
    const data = targetAbundances(response);
    const definition = defineChart({
      marks: [
        barX(data, { x: "abundance", y: "label", key: "id", fill: "#2563eb" }),
        text(data, {
          x: "abundance",
          y: "label",
          key: "id",
          text: (row) => percent.format(row.abundance / 100),
          anchor: "start",
          dx: 8,
          fontSize: 12,
          fontWeight: 600,
        }),
      ],
      scales: {
        x: {
          scale: scaleLinear().domain([0, 100]),
          nice: false,
          grid: true,
          axis: { ticks: { format: (value) => `${value}%` } },
        },
        y: {
          scale: scaleBand<string>()
            .domain(data.map((row) => row.label))
            .padding(0.3),
        },
      },
    });
    return {
      definition,
      label: `Compare abundance as a percentage of the same sample. ${data.map((row) => `${row.label}: ${percent.format(row.abundance / 100)}`).join("; ")}.`,
      count: data.length,
    };
  }, [response]);
  return (
    <figure aria-label="Count abundance for each target">
      <Chart
        definition={definition}
        ariaLabel={label}
        initialWidth={640}
        height={count * 36 + 64}
      />
      <figcaption>
        If a record matches two targets, both receive its full abundance. The bars can add to more
        than 100%.
      </figcaption>
    </figure>
  );
}
