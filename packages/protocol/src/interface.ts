import type { Cluster, FaceIndex, HexCell, SemanticChannel } from "./types.js";

export interface ExternalFace {
  index: FaceIndex;
  semanticChannels: SemanticChannel[];
  projectionPopulation: string[];
}

export interface ExternalNodeInterface {
  id: string;
  faces: [ExternalFace, ExternalFace, ExternalFace, ExternalFace, ExternalFace, ExternalFace];
}

export function externalInterfaceFromCell(cell: HexCell): ExternalNodeInterface {
  return {
    id: cell.id,
    faces: cell.faces.map((face) => ({
      index: face.index,
      semanticChannels: face.semanticChannels,
      projectionPopulation: face.projectionPopulation,
    })) as ExternalNodeInterface["faces"],
  };
}

export function externalInterfaceFromCluster(cluster: Cluster): ExternalNodeInterface {
  return {
    id: cluster.id,
    faces: cluster.macroFaces.map((face) => ({
      index: face.index,
      semanticChannels: face.semanticChannels,
      projectionPopulation: face.projectionPopulation,
    })) as ExternalNodeInterface["faces"],
  };
}
