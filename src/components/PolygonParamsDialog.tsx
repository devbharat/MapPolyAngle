import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  polygonId: string | null;
  onClose: () => void;
  onSubmit: (params: { altitudeAGL: number; frontOverlap: number; sideOverlap: number }) => void;
  onSubmitAll?: (params: { altitudeAGL: number; frontOverlap: number; sideOverlap: number }) => void; // bulk apply
  defaults?: { altitudeAGL?: number; frontOverlap?: number; sideOverlap?: number };
};

export default function PolygonParamsDialog({
  open,
  polygonId,
  onClose,
  onSubmit,
  onSubmitAll,
  defaults
}: Props) {
  const [altitudeAGL, setAltitudeAGL] = React.useState<number>(defaults?.altitudeAGL ?? 100);
  const [frontOverlap, setFrontOverlap] = React.useState<number>(defaults?.frontOverlap ?? 80);
  const [sideOverlap, setSideOverlap] = React.useState<number>(defaults?.sideOverlap ?? 70);

  React.useEffect(() => {
    // reset when a new polygon is requested
    if (open) {
      setAltitudeAGL(defaults?.altitudeAGL ?? 100);
      setFrontOverlap(defaults?.frontOverlap ?? 80);
      setSideOverlap(defaults?.sideOverlap ?? 70);
    }
  }, [open, defaults?.altitudeAGL, defaults?.frontOverlap, defaults?.sideOverlap]);

  if (!open || !polygonId) return null;

  return (
    <div className="absolute top-2 left-2 z-50 w-80">
      <Card className="shadow-lg">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Flight setup for <span className="font-mono">#{polygonId.slice(0,8)}</span></CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <label className="text-xs text-gray-600 block">
            Altitude AGL (m)
            <input className="w-full border rounded px-2 py-1 text-xs" type="number"
                   value={altitudeAGL}
                   onChange={(e)=>setAltitudeAGL(parseInt(e.target.value || "100"))} />
          </label>
          <label className="text-xs text-gray-600 block">
            Front overlap (%)
            <input className="w-full border rounded px-2 py-1 text-xs" type="number" min={0} max={95}
                   value={frontOverlap}
                   onChange={(e)=>setFrontOverlap(parseInt(e.target.value || "80"))} />
          </label>
          <label className="text-xs text-gray-600 block">
            Side overlap (%)
            <input className="w-full border rounded px-2 py-1 text-xs" type="number" min={0} max={95}
                   value={sideOverlap}
                   onChange={(e)=>setSideOverlap(parseInt(e.target.value || "70"))} />
          </label>

          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              className="flex-1 min-w-0 h-8 px-2 text-xs"
              onClick={() => onSubmit({ altitudeAGL, frontOverlap, sideOverlap })}>
              Apply
            </Button>
            {onSubmitAll && (
              <Button
                size="sm"
                variant="secondary"
                className="h-8 px-2 text-xs whitespace-nowrap"
                onClick={() => onSubmitAll({ altitudeAGL, frontOverlap, sideOverlap })}
                title="Apply these parameters to all remaining polygons awaiting setup"
              >
                Apply All
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2 text-xs whitespace-nowrap"
              onClick={onClose}
            >
              Cancel
            </Button>
          </div>
          <p className="text-[11px] text-gray-500">
            {onSubmitAll ? 'Use Apply All to apply these parameters to every remaining polygon in this import batch.' : 'After applying, flight lines and GSD will run for this polygon only.'}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
