/**
 * MCP Resource: pelaris://sports/methodologies
 *
 * Static data: list of sports with their available training methodologies.
 * Sourced from the methodology database (28 sub-methodologies across 7 sport categories).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SPORT_METHODOLOGIES = {
  sports: [
    {
      sport: "Strength",
      methodologies: [
        { id: "5_3_1", name: "5/3/1 (Wendler)", focus: "Slow, steady strength gains with submaximal training" },
        { id: "531_bbb", name: "5/3/1 Boring But Big", focus: "Hypertrophy supplement to 5/3/1 base" },
        { id: "gzcl", name: "GZCL Method", focus: "Tiered approach — heavy compound, moderate volume, light accessories" },
        { id: "nsuns", name: "nSuns LP", focus: "High-volume linear progression for intermediates" },
        { id: "phat", name: "PHAT", focus: "Power + hypertrophy across the week" },
        { id: "push_pull_legs", name: "Push/Pull/Legs", focus: "Movement-pattern split for balanced development" },
        { id: "upper_lower", name: "Upper/Lower Split", focus: "Simple frequency-based split for strength and size" },
      ],
    },
    {
      sport: "Running",
      methodologies: [
        { id: "80_20_running", name: "80/20 Running", focus: "80% easy, 20% hard — polarized approach" },
        { id: "daniels_running", name: "Jack Daniels' VDOT", focus: "Pace-zone training based on race equivalency" },
        { id: "hansons", name: "Hansons Method", focus: "Cumulative fatigue — simulate race-day legs" },
        { id: "higdon", name: "Hal Higdon", focus: "Accessible programs for beginners to advanced" },
        { id: "lydiard", name: "Lydiard Base Building", focus: "Aerobic base before sharpening" },
        { id: "maf", name: "MAF (Maffetone)", focus: "Heart-rate-based aerobic development" },
        { id: "pfitzinger", name: "Pfitzinger", focus: "Lactate threshold emphasis with structured plans" },
        { id: "run_walk_run", name: "Run/Walk/Run (Galloway)", focus: "Interval-based approach for injury prevention" },
      ],
    },
    {
      sport: "Swimming",
      methodologies: [
        { id: "usrpt", name: "USRPT (Ultra-Short Race Pace Training)", focus: "Race-pace intervals with failure-based sets" },
        { id: "total_immersion", name: "Total Immersion", focus: "Efficiency-first — reduce drag, improve stroke" },
        { id: "swim_smooth", name: "Swim Smooth", focus: "Swim-type profiling with targeted drills" },
      ],
    },
    {
      sport: "Cycling",
      methodologies: [
        { id: "sweet_spot", name: "Sweet Spot Training", focus: "88-94% FTP — maximum adaptation per time invested" },
        { id: "polarised_cycling", name: "Polarised Cycling", focus: "80% zone 1-2, 20% zone 4-5" },
        { id: "coggan_zones", name: "Coggan Power Zones", focus: "Power-based training with 7 zones" },
        { id: "traditional_base", name: "Traditional Base", focus: "High-volume low-intensity base building" },
      ],
    },
    {
      sport: "Triathlon",
      methodologies: [
        { id: "tri_80_20", name: "80/20 Triathlon", focus: "Polarised intensity across three disciplines" },
        { id: "tri_time_crunched", name: "Time-Crunched Triathlon", focus: "Efficient training for busy athletes" },
        { id: "tri_base_build", name: "Triathlon Base Build", focus: "Aerobic foundation across swim/bike/run" },
        { id: "tri_race_specific", name: "Race-Specific Triathlon", focus: "Distance-targeted race preparation" },
      ],
    },
    {
      sport: "CrossFit",
      methodologies: [
        { id: "crossfit_general", name: "CrossFit General", focus: "Constantly varied functional movements at high intensity" },
      ],
    },
    {
      sport: "General Fitness",
      methodologies: [
        { id: "general_fitness", name: "General Fitness", focus: "Balanced approach — strength, cardio, flexibility" },
      ],
    },
  ],
  totalMethodologies: 28,
  note: "Each methodology includes enriched training data: session distributions, deload protocols, and key constraints used during program generation.",
};

export function registerMethodologiesResource(server: McpServer): void {
  server.resource(
    "sports-methodologies",
    "pelaris://sports/methodologies",
    {
      description: "Complete list of supported sports and their training methodologies. Use this to understand which training approaches are available and what each one focuses on.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "pelaris://sports/methodologies",
          mimeType: "application/json",
          text: JSON.stringify(SPORT_METHODOLOGIES, null, 2),
        },
      ],
    }),
  );
}
