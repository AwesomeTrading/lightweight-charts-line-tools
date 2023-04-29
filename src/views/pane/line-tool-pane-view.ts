import { IInputEventListener, InputEventType, TouchMouseEvent } from '../../gui/mouse-event-handler';
import { PaneWidget } from '../../gui/pane-widget';

import { ensureNotNull } from '../../helpers/assertions';

import { BarPrice } from '../../model/bar';
import { ChartModel } from '../../model/chart-model';
import { Coordinate } from '../../model/coordinate';
import { HitTestResult, HitTestType } from '../../model/hit-test-result';
import { LineTool, LineToolHitTestData, LineToolPoint } from '../../model/line-tool';
import { LineToolType } from '../../model/line-tool-options';
import { PaneCursorType } from '../../model/pane';
import { Point } from '../../model/point';
import { CompositeRenderer } from '../../renderers/composite-renderer';
import { IPaneRenderer } from '../../renderers/ipane-renderer';
import { AnchorPoint, LineAnchorRenderer } from '../../renderers/line-anchor-renderer';

import { IUpdatablePaneView } from './iupdatable-pane-view';

export interface CreateAnchorData {
	points: AnchorPoint[];
	pointsCursorType?: PaneCursorType[];
}

export abstract class LineToolPaneView implements IUpdatablePaneView, IInputEventListener {
	protected readonly _source: LineTool<LineToolType>;
	protected readonly _model: ChartModel;
	protected _points: AnchorPoint[] = [];

	protected _invalidated: boolean = true;
	protected _lastMovePoint: Point | null = null;
	protected _editedPointIndex: number | null = null;
	protected _lineAnchorRenderers: LineAnchorRenderer[] = [];
	protected _renderer: IPaneRenderer | null = null;

	public constructor(source: LineTool<LineToolType>, model: ChartModel) {
		this._source = source;
		this._model = model;
	}

	// eslint-disable-next-line complexity
	public onInputEvent(paneWidget: PaneWidget, ctx: CanvasRenderingContext2D, eventType: InputEventType, event?: TouchMouseEvent): void {
		if (!event || (!this._renderer || !this._renderer.hitTest) && this._source.finished()) { return; }

		const crossHair = this._model.crosshairSource();
		const appliedPoint = new Point(crossHair.appliedX(), crossHair.appliedY());
		const originPoint = new Point(crossHair.originCoordX(), crossHair.originCoordY());

		const changed = eventType === InputEventType.PressedMouseMove && !event.consumed
			? this._onPressedMouseMove(paneWidget, ctx, originPoint, appliedPoint, event)
			: eventType === InputEventType.MouseMove
			? this._onMouseMove(paneWidget, ctx, originPoint, appliedPoint, event)
			: eventType === InputEventType.MouseDown
			? this._onMouseDown(paneWidget, ctx, originPoint, appliedPoint, event)
			: eventType === InputEventType.MouseUp
			? this._onMouseUp()
			: false;

		event.consumed ||= this._source.editing() || !this._source.finished();
		if (changed || this._source.hovered() || this._source.editing() || ! this._source.finished()) {
			this.updateLineAnchors();
		}
	}

	public renderer(height: number, width: number, addAnchors?: boolean | undefined): IPaneRenderer | null {
		if (this._invalidated) { this._updateImpl(height, width); }
		return this._source.visible() ? this._renderer : null;
	}

	public priceToCoordinate(price: BarPrice): Coordinate | null {
		const priceScale = this._source.priceScale();
		const ownerSource = this._source.ownerSource();

		if (priceScale === null) { return null; }

		const basePrice = ownerSource !== null ? ownerSource.firstValue() : null;
		return basePrice === null ? null : priceScale.priceToCoordinate(price, basePrice.value);
	}

	public currentPoint(): Point {
		const crossHair = this._model.crosshairSource();
		return new Point(crossHair.originCoordX(), crossHair.originCoordY());
	}

	public editedPointIndex(): number | null {
		return this._source.editing() ? this._editedPointIndex : null;
	}

	public areAnchorsVisible(): boolean {
		return this._source.hovered() || this._source.selected() || this._source.editing() || !this._source.finished();
	}

	public update(): void {
		this._invalidated = true;
	}

	public addAnchors(renderer: CompositeRenderer): void {
		renderer.append(this.createLineAnchor({ points: this._points }, 0));
	}

	public updateLineAnchors(): void {
		this._lineAnchorRenderers.forEach((renderer: LineAnchorRenderer) => {
			renderer.updateData({
				points: this._points,
				selected: this._source.selected(),
				visible: this.areAnchorsVisible(),
				currentPoint: this.currentPoint(),
				editedPointIndex: this.editedPointIndex(),
			});
		});
		this._model.updateSource(this._source);
		this._source.updateAllViews();
	}

	public createLineAnchor(data: CreateAnchorData, index: number): LineAnchorRenderer {
		const renderer = this._getLineAnchorRenderer(index);
		renderer.setData({
			...data,
			radius: 6,
			strokeWidth: 1,
			color: '#1E53E5',
			hoveredStrokeWidth: 4,
			selected: this._source.selected(),
			visible: this.areAnchorsVisible(),
			currentPoint: this.currentPoint(),
			backgroundColors: this._lineAnchorColors(data.points),
			editedPointIndex: this._source.editing() ? this.editedPointIndex() : null,
			hitTestType: HitTestType.ChangePoint,
		});

		return renderer;
	}

	protected _onMouseUp(): boolean {
		if (!this._source.finished()) {
			this._source.tryFinish();
		} else if (this._source.editing()) {
			this._model.magnet().disable();
			this._updateSourcePoints();

			this._lastMovePoint = null;
			this._editedPointIndex = null;
			this._source.setEditing(false);
			this._source.setCreating(false);
			return true;
		}
		return false;
	}

	protected _onPressedMouseMove(paneWidget: PaneWidget, ctx: CanvasRenderingContext2D, originPoint: Point, appliedPoint: Point, event: TouchMouseEvent): boolean {
		if (!this._source.finished()) {
			if (this._source.lineDrawnWithPressedButton()) {
				this._source.addPoint(this._source.screenPointToPoint(appliedPoint) as LineToolPoint);
			}
			return false;
		}

		if (!this._source.selected()) { return false; }

		if (!this._source.editing()) {
			const hitResult = this._hitTest(paneWidget, ctx, originPoint);
			const hitData = hitResult?.data();
			this._source.setEditing(this._source.hovered() || !!hitResult);

			this._lastMovePoint = appliedPoint;
			this._editedPointIndex = hitData?.pointIndex ?? this._editedPointIndex;
			if (hitData) { this._model.magnet().enable(); }
		} else {
			paneWidget.setCursor(this._editedPointIndex !== null ? PaneCursorType.Default : PaneCursorType.Grabbing);

			if (this._editedPointIndex !== null) {
				this._tryApplyLineToolShift(appliedPoint, event, true);

				this._source.setPoint(this._editedPointIndex, this._source.screenPointToPoint(appliedPoint) as LineToolPoint);
			} else if (this._lastMovePoint) {
				const diff = appliedPoint.subtract(this._lastMovePoint);
				this._points.forEach((point: Point) => {
					point.x = (point.x + diff.x) as Coordinate;
					point.y = (point.y + diff.y) as Coordinate;
				});

				this._lastMovePoint = appliedPoint;
				this._updateSourcePoints();
			}
		}
		return false;
	}

	protected _onMouseMove(paneWidget: PaneWidget, ctx: CanvasRenderingContext2D, originPoint: Point, appliedPoint: Point, event: TouchMouseEvent): boolean {
		if (!this._source.finished()) {
			if (this._source.hasMagnet()) { this._model.magnet().enable(); }

			this._tryApplyLineToolShift(appliedPoint, event, false);

			this._source.setLastPoint(this._source.screenPointToPoint(appliedPoint) as LineToolPoint);
		} else {
			const hitResult = this._hitTest(paneWidget, ctx, originPoint);
			const changed = this._source.setHovered(hitResult !== null && !event.consumed);

			if (this._source.hovered() && !event.consumed) {
				paneWidget.setCursor(hitResult?.data()?.cursorType || PaneCursorType.Pointer);
				this._editedPointIndex = hitResult?.data()?.pointIndex ?? null;
			}

			return changed;
		}

		return false;
	}

	protected _onMouseDown(paneWidget: PaneWidget, ctx: CanvasRenderingContext2D, originPoint: Point, appliedPoint: Point, event: TouchMouseEvent): boolean {
		if (!this._source.finished()) {
			this._tryApplyLineToolShift(appliedPoint, event, false);

			this._source.addPoint(this._source.screenPointToPoint(appliedPoint) as LineToolPoint);
			return false;
		} else {
			const hitResult = this._hitTest(paneWidget, ctx, originPoint);
			return this._source.setSelected(hitResult !== null && !event.consumed);
		}
	}

	protected _updateSourcePoints(): void {
		this._source.setPoints(this._points.map((point: Point) => this._source.screenPointToPoint(point) as LineToolPoint));
	}

	protected _hitTest(paneWidget: PaneWidget, ctx: CanvasRenderingContext2D, point: Point): HitTestResult<LineToolHitTestData> | null {
		if (!this._renderer?.hitTest) { return null; }
		return this._renderer.hitTest(point.x, point.y, ctx) as HitTestResult<LineToolHitTestData> | null;
	}

	protected _lineAnchorColors(points: AnchorPoint[]): string[] {
		const height = ensureNotNull(this._model.paneForSource(this._source)).height();
		return points.map((point: AnchorPoint) => this._model.backgroundColorAtYPercentFromTop(point.y / height));
	}

	protected _updateImpl(height?: number, width?: number): void {
		this._invalidated = false;

		if (this._model.timeScale().isEmpty()) { return; }
		if (!this._validatePriceScale()) { return; }

		this._points = [] as AnchorPoint[];
		const sourcePoints = this._source.points();
		for (let i = 0; i < sourcePoints.length; i++) {
			const point = this._source.pointToScreenPoint(sourcePoints[i]) as AnchorPoint;
			if (!point) { return; }
			point.data = i;
			this._points.push(point);
		}
	}

	protected _validatePriceScale(): boolean {
		const priceScale = this._source.priceScale();
		return null !== priceScale && !priceScale.isEmpty();
	}

	protected _getLineAnchorRenderer(index: number): LineAnchorRenderer {
		for (; this._lineAnchorRenderers.length <= index;) {this._lineAnchorRenderers.push(new LineAnchorRenderer());}
		return this._lineAnchorRenderers[index];
	}

	protected _tryApplyLineToolShift(appliedPoint: Point, event: TouchMouseEvent, useEditedPointIndex: boolean): void {
		const isTrendLine = this._isTrendLine();

		// if shift, isTrendLine = true and at least 1 point exists already
		if (event.shiftKey === true && isTrendLine === true && this._points.length > 0) {
			// override point
			if (useEditedPointIndex) {
				if (this._editedPointIndex === 1) {
					appliedPoint.y = this._points[0].y;
				} else if (this._editedPointIndex === 0) {
					appliedPoint.y = this._points[1].y;
				} else if (this._editedPointIndex === 2) {
					// parallelChannel is the only tool supporting holding shift that has 3-4 points
					// points does not track point 3, so i have to use the diference from 0 and 1 and offset 2 so it now match what point 3 is without knowing anything about 3
					const dif = this._points[0].y - this._points[1].y;
					appliedPoint.y = (this._points[2].y - dif) as Coordinate;
				} else if (this._editedPointIndex === 3) {
					// parallelChannel is the only tool supporting holding shift that has 3-4 points
					appliedPoint.y = this._points[2].y;
				}
			} else {
				// if shift, isTrendLine = true and at least 1 point exists already
				if (event.shiftKey === true && isTrendLine === true && this._points.length > 0) {
					// override point 2's y with point 1's y
					appliedPoint.y = this._points[0].y;
				}
			}
		}
	}

	protected _isTrendLine(): boolean {
		let isTrendLine = false;
		const toolTypeStr = String(this._source.toolType());
		if (toolTypeStr === 'TrendLine' || toolTypeStr === 'Ray' || toolTypeStr === 'Arrow' || toolTypeStr === 'ExtendedLine' || toolTypeStr === 'ParallelChannel') {
			isTrendLine = true;
		}
		return isTrendLine;
	}
}
