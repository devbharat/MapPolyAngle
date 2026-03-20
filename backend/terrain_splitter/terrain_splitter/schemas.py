from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

PayloadKind = Literal["camera", "lidar"]
AltitudeMode = Literal["legacy", "min-clearance"]
LidarReturnMode = Literal["single", "dual", "triple"]
LidarComparisonMode = Literal["first-return", "all-returns"]


class FlightParamsModel(BaseModel):
    payloadKind: PayloadKind = "camera"
    altitudeAGL: float = Field(..., gt=0)
    frontOverlap: float = Field(70, ge=0, le=95)
    sideOverlap: float = Field(70, ge=0, le=95)
    cameraKey: str | None = None
    lidarKey: str | None = None
    triggerDistanceM: float | None = None
    cameraYawOffsetDeg: float | None = None
    speedMps: float | None = None
    lidarReturnMode: LidarReturnMode | None = None
    mappingFovDeg: float | None = None
    lidarFrameRateHz: float | None = None
    lidarAzimuthSectorCenterDeg: float | None = None
    lidarBoresightYawDeg: float | None = None
    lidarBoresightPitchDeg: float | None = None
    lidarBoresightRollDeg: float | None = None
    lidarComparisonMode: LidarComparisonMode | None = None
    maxLidarRangeM: float | None = None
    pointDensityPtsM2: float | None = None
    useCustomBearing: bool | None = None
    customBearingDeg: float | None = None


class PartitionSolveRequest(BaseModel):
    polygonId: str | None = None
    ring: list[tuple[float, float]]
    payloadKind: PayloadKind
    params: FlightParamsModel
    altitudeMode: AltitudeMode = "legacy"
    minClearanceM: float = Field(60, ge=0)
    turnExtendM: float = Field(96, ge=0)
    tradeoff: float | None = Field(default=None, ge=0, le=1)
    debug: bool = False

    @model_validator(mode="after")
    def validate_ring_and_payload(self) -> "PartitionSolveRequest":
        if len(self.ring) < 3:
            raise ValueError("Polygon ring must have at least 3 coordinates.")
        if self.params.payloadKind != self.payloadKind:
            self.params.payloadKind = self.payloadKind
        return self


class RegionPreview(BaseModel):
    areaM2: float
    bearingDeg: float
    atomCount: int
    ring: list[tuple[float, float]]
    convexity: float
    compactness: float
    baseAltitudeAGL: float | None = None


class DebugArtifacts(BaseModel):
    requestId: str
    artifactPaths: list[str] = Field(default_factory=list)


class PartitionSolutionPreviewModel(BaseModel):
    signature: str
    tradeoff: float
    regionCount: int
    totalMissionTimeSec: float
    normalizedQualityCost: float
    weightedMeanMismatchDeg: float
    hierarchyLevel: int
    largestRegionFraction: float
    meanConvexity: float
    boundaryBreakAlignment: float
    isFirstPracticalSplit: bool
    regions: list[RegionPreview]
    debug: DebugArtifacts | None = None


class PartitionSolveResponse(BaseModel):
    requestId: str
    solutions: list[PartitionSolutionPreviewModel]
    debug: DebugArtifacts | None = None
