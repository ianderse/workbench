/** The parts of d3-force-3d (which ships no types) that the graph layout worker uses */
declare module 'd3-force-3d' {
  export interface SimulationNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLink<N extends SimulationNode> {
    source: number | N;
    target: number | N;
  }

  export interface Force<N extends SimulationNode> {
    (alpha: number): void;
    initialize?(nodes: N[], ...args: unknown[]): void;
  }

  export interface Simulation<N extends SimulationNode> {
    tick(iterations?: number): this;
    restart(): this;
    stop(): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaMin(): number;
    alphaTarget(target: number): this;
    alphaDecay(decay: number): this;
    velocityDecay(decay: number): this;
    force(name: string, force: Force<N> | null): this;
    on(type: 'tick' | 'end', listener: (() => void) | null): this;
  }

  export interface LinkForce<N extends SimulationNode> extends Force<N> {
    distance(distance: number): this;
    strength(strength: number): this;
  }

  export interface ManyBodyForce<N extends SimulationNode> extends Force<N> {
    strength(strength: number): this;
    theta(theta: number): this;
    distanceMax(distance: number): this;
  }

  export interface StrengthForce<N extends SimulationNode> extends Force<N> {
    strength(strength: number): this;
  }

  export function forceSimulation<N extends SimulationNode>(nodes?: N[], numDimensions?: 1 | 2 | 3): Simulation<N>;
  export function forceLink<N extends SimulationNode>(links?: Array<SimulationLink<N>>): LinkForce<N>;
  export function forceManyBody<N extends SimulationNode>(): ManyBodyForce<N>;
  export function forceCenter<N extends SimulationNode>(x?: number, y?: number, z?: number): StrengthForce<N>;
  export function forceX<N extends SimulationNode>(x?: number): StrengthForce<N>;
  export function forceY<N extends SimulationNode>(y?: number): StrengthForce<N>;
  export function forceZ<N extends SimulationNode>(z?: number): StrengthForce<N>;
}
