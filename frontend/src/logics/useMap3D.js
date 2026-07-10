import * as Cesium from 'cesium';
import { ref, computed } from 'vue';
import { getPointIcon, drawHalfCylinder, drawServiceRadius, rippleIntervals } from '@/utils/cesiumHelper';
import { getEducationSupply, getRecommendedSites } from '@/services/api';
import { useVectorStore } from '@/stores/vectorStore';

// 常量定义--设施用地颜色样式
const LAND_STYLES = {
  '居住用地': 'rgba(255, 255, 45, 0.6)',
  '商业用地': 'rgba(255, 0, 0, 0.6)',
  '工业用地': 'rgba(187, 150, 116, 0.6)',
  '公园绿地': 'rgba(0, 255, 0, 0.6)',
  '行政管理用地': 'rgba(254, 24, 201, 0.6)',
  '文体设施用地': 'rgba(254, 24, 201, 0.6)',
  '医疗卫生用地': 'rgba(254, 24, 201, 0.6)',
  '教育设施用地': 'rgba(254, 24, 201, 0.6)',
  '社会福利用地': 'rgba(254, 24, 201, 0.6)'
}

// 根据设施类型返回服务半径（米）
function getRadiusByType(type) {
  const map = {
    '幼儿园': 300, '小学': 500, '初中': 1000,
    '九年一贯制学校': 1000, '医院': 1000,
    '社区健康服务中心': 500, '社区体育设施': 500,
    '社区文化设施': 500, '大型体育设施': 1500,
    '大型文化设施': 1500
  };
  return map[type] || 300;
}

export function useMap3D(cesiumContainer, TIANDITU_API_KEY, buildingColors, defaultBuildingColor, layers, activeBasemapId) {
  const vectorStore = useVectorStore();
  const viewer = ref(null);
  const cesiumInitialized = ref(false);
  // 实体管理
  let pointEntities = [];
  let landEntities = [];
  let lastHighlighted = null;
  let buildingDataMap = {};  // 建筑 Primitive 点击回查

  // 3D 弹窗
  let cesiumPopupDiv = null;
  let cesiumPopupCloseBtn = null;

  let isFlying = false;
  const isAnalyzing = ref(false);
  const currentAnalysisIndex = ref(0);
  const analysisFacilities = ref([]);

  let educationSupplyData = [];
  let analysisEntities = [];
  let recommendEntities = [];

  const analysisButtonText = computed(() => {
    if (isAnalyzing.value) {
      return `下一个 (${currentAnalysisIndex.value + 1}/${analysisFacilities.value.length})`;
    }
    return '漫游分析';
  });

  async function loadCesium() {
    if (cesiumInitialized.value) return;

    window.CESIUM_BASE_URL = '/cesium';

    await import('cesium/Build/Cesium/Widgets/widgets.css');

    Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;

    const terrainProvider = await Cesium.createWorldTerrainAsync({
      requestVertexNormals: true,
    });

    viewer.value = new Cesium.Viewer(cesiumContainer.value, {
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      animation: false,
      timeline: false,
      infoBox: false,
      imageryProvider: false,
      selectionIndicator: false,
      terrainProvider: terrainProvider,
    });

    viewer.value.cesiumWidget.creditContainer.style.display = 'none';
    viewer.value.imageryLayers.removeAll();

    if (TIANDITU_API_KEY) {
      viewer.value.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
        url: `https://t0.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${TIANDITU_API_KEY}`,
        subdomains: ['0', '1', '2', '3', '4', '5', '6', '7']
      }));
    }

    viewer.value.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(114.03, 22.58, 1800),
      orientation: {
        heading: Cesium.Math.toRadians(-10),
        pitch: Cesium.Math.toRadians(-30),
        roll: 0
      }
    });

    await loadBuildings();
    await loadPointsAndLands(layers.value);
    await loadEducationSupplyData();
    setupCesiumClickHandler();

    cesiumInitialized.value = true;
  }

  function setupCesiumClickHandler() {
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.value.scene.canvas);
    handler.setInputAction((click) => {
      const pick = viewer.value.scene.pick(click.position);

      if (lastHighlighted) {
        if (lastHighlighted.polygon) {
          if (lastHighlighted._originalOutlineColor !== undefined) {
            lastHighlighted.polygon.outlineColor = lastHighlighted._originalOutlineColor;
          }
          if (lastHighlighted._originalOutlineWidth !== undefined) {
            lastHighlighted.polygon.outlineWidth = lastHighlighted._originalOutlineWidth;
          }
          if (lastHighlighted._originalMaterial) {
            lastHighlighted.polygon.material = lastHighlighted._originalMaterial;
          }
        }
        if (lastHighlighted.billboard) {
          lastHighlighted.billboard.scale = lastHighlighted._originalScale || 0.8;
        }
        if (lastHighlighted.label) {
          lastHighlighted.label.font = lastHighlighted._originalFont || '14px "Microsoft YaHei", Arial, sans-serif';
        }
        lastHighlighted = null;
      }

      // 先判断：是不是点到了建筑 Primitive？
      if (Cesium.defined(pick) && pick.primitive && typeof pick.id === 'number') {
        const props = buildingDataMap[pick.id];
        if (props) {
          showCesiumPopup(props, click.position);
        }

      } else if (Cesium.defined(pick) && pick.id) {
        const entity = pick.id;
        lastHighlighted = entity;

        if (entity.polygon) {
          const currentOutlineColor = entity.polygon.outlineColor?.getValue();
          entity._originalOutlineColor = currentOutlineColor
            ? currentOutlineColor.clone()
            : Cesium.Color.TRANSPARENT.clone();
          entity._originalOutlineWidth = entity.polygon.outlineWidth?.getValue() || 1.0;
          if (!entity._originalMaterial) {
            entity._originalMaterial = entity.polygon.material;
          }
          entity.polygon.material = Cesium.Color.fromCssColorString('rgba(255, 255, 255, 0.3)');
          entity.polygon.outlineColor = Cesium.Color.WHITE;
          entity.polygon.outlineWidth = 1;
        }

        if (entity.billboard) {
          entity._originalScale = entity.billboard.scale?.getValue() || 0.8;
          entity.billboard.scale = entity._originalScale * 1.5;
        }

        if (entity.label) {
          entity._originalFont = entity.label.font?.getValue() || '14px "Microsoft YaHei", Arial, sans-serif';
          entity.label.font = '16px "Microsoft YaHei", Arial, sans-serif';
        }

        setTimeout(() => {
          let properties = entity.properties;
          if (properties && typeof properties.getValue === 'function') {
            properties = properties.getValue();
          }
          // 对于建筑实体，properties 可能直接挂在 entity 上
          if (!properties && entity._properties) {
            properties = entity._properties;
          }
          if (properties) {
            showCesiumPopup(properties, click.position);
          } else {
            console.warn('未能提取到实体属性');
          }
        }, 100);
      } else {
        closeCesiumPopup();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  async function loadBuildings() {
    const API_BASE = import.meta.env.PROD ? '' : 'http://localhost:3000';
    const response = await fetch(`${API_BASE}/api/buildings`);
    const result = await response.json();

    const instances = [];
    buildingDataMap = {};  // 重置建筑数据映射

    result.data.features.forEach((feature, index) => {
      const props = feature.properties;

      // 跳过没有几何数据的要素
      if (!feature.geometry || !feature.geometry.coordinates) return;

      let height = props.height || (props.up_floor ? props.up_floor * 3 : 10);
      const color = buildingColors[props.type] || defaultBuildingColor;
      const cesiumColor = Cesium.Color.fromCssColorString(color);

      // 兼容 Polygon 和 MultiPolygon，取第一个外环
      let outerRing;
      if (feature.geometry.type === 'MultiPolygon') {
        outerRing = feature.geometry.coordinates[0][0];
      } else {
        outerRing = feature.geometry.coordinates[0];
      }
      const positions = outerRing.flatMap(c => [c[0], c[1]]);

      const geometry = new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArray(positions)
        ),
        extrudedHeight: height,
        perPositionHeight: false,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
      });

      instances.push(new Cesium.GeometryInstance({
        geometry: geometry,
        id: index,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(cesiumColor)
        }
      }));

      buildingDataMap[index] = props;
    });

    const primitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({
        closed: true,
        translucent: true
      }),
      asynchronous: false  // 确保立即可见
    });

    viewer.value.scene.primitives.add(primitive);
  }

  // ==================== 实体创建辅助函数 ====================
  function createPointEntity(point) {
    const [lng, lat] = point.geometry.coordinates;
    const entity = viewer.value.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lng, lat, 0),
      billboard: {
        image: getPointIcon(point.type),
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        scale: 0.8,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
      },
      label: {
        text: point.name,
        font: '14px "Microsoft YaHei", Arial, sans-serif',
        pixelOffset: new Cesium.Cartesian2(15, -2),
        fillColor: Cesium.Color.BLACK,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
      },
      properties: point
    });
    entity._dataId = point.id;
    return entity;
  }

  function createLandEntity(land) {
    const hierarchy = new Cesium.PolygonHierarchy(
      land.geometry.coordinates[0].map(coord =>
        Cesium.Cartesian3.fromDegrees(coord[0], coord[1])
      ),
      land.geometry.coordinates.slice(1).map(ring =>
        ring.map(coord => Cesium.Cartesian3.fromDegrees(coord[0], coord[1]))
      )
    );
    const entity = viewer.value.entities.add({
      polygon: {
        hierarchy: hierarchy,
        material: Cesium.Color.fromCssColorString(
          LAND_STYLES[land.type] || 'rgba(0,0,0,0.5)'
        ),
        outline: true,
        outlineColor: Cesium.Color.WHITE
      },
      properties: land
    });
    entity._dataId = land.id;
    return entity;
  }

  async function loadPointsAndLands(currentLayers) {
    if (!viewer.value) return;
    const layersToUse = currentLayers || layers?.value || layers;
    const pointsConfig = layersToUse.points;
    const landsConfig = layersToUse.lands;

    // 确保数据已加载（只加载一次）
    if (vectorStore.points.length === 0) await vectorStore.loadPoints();
    if (vectorStore.lands.length === 0) await vectorStore.loadLands();

    // ========== 增量更新点要素 ==========

    // 计算当前筛选后的点集合
    let filteredPoints = [];
    if (pointsConfig.visible) {
      filteredPoints = pointsConfig.selectedType === '全部类型'
        ? vectorStore.points
        : vectorStore.points.filter(p => p.type === pointsConfig.selectedType);
    }

    const newPointIds = new Set(filteredPoints.map(p => p.id));

    // 移除不再显示的实体
    for (let i = pointEntities.length - 1; i >= 0; i--) {
      if (!newPointIds.has(pointEntities[i]._dataId)) {
        viewer.value.entities.remove(pointEntities[i]);
        pointEntities.splice(i, 1);
      }
    }

    // 添加新增的实体
    const existingPointIds = new Set(pointEntities.map(e => e._dataId));
    filteredPoints.forEach(point => {
      if (!existingPointIds.has(point.id)) {
        pointEntities.push(createPointEntity(point));
      }
    });

    // ========== 增量更新面要素 ==========

    // 计算当前筛选后的面集合
    let filteredLands = [];
    if (landsConfig.visible) {
      filteredLands = landsConfig.selectedType === '全部类型'
        ? vectorStore.lands
        : vectorStore.lands.filter(l => l.type === landsConfig.selectedType);
    }

    const newLandIds = new Set(filteredLands.map(l => l.id));

    // 移除不再显示的实体
    for (let i = landEntities.length - 1; i >= 0; i--) {
      if (!newLandIds.has(landEntities[i]._dataId)) {
        viewer.value.entities.remove(landEntities[i]);
        landEntities.splice(i, 1);
      }
    }

    // 添加新增的实体
    const existingLandIds = new Set(landEntities.map(e => e._dataId));
    filteredLands.forEach(land => {
      if (!existingLandIds.has(land.id)) {
        landEntities.push(createLandEntity(land));
      }
    });
  }

  function toggleLayer(layerKey) {
    const layerObj = layers.value[layerKey]
    if (layerObj.visible && !layerObj.loaded) {
      layerObj.loaded = true
    }
    loadPointsAndLands(layers.value)
  }

  function onTypeChange(layerKey) {
    if (layers.value[layerKey].loaded) {
      loadPointsAndLands(layers.value)
    }
  }

  async function loadEducationSupplyData() {
    try {
      const res = await getEducationSupply();
      if (res.success) educationSupplyData = res.data;
      else console.error('加载供需数据失败', res.message);
    } catch (err) {
      console.error('加载供需数据异常', err);
    }
  }

  async function startFlythrough() {
    if (!viewer.value || isFlying) return;
    isFlying = true;

    try {
      viewer.value.scene.screenSpaceCameraController.enableInputs = false;

      const flightPath = [
        { lng: 114.0310, lat: 22.5900, height: 1200, heading: -21, pitch: -40, duration: 2 },
        { lng: 114.0305, lat: 22.5940, height: 800, heading: -26, pitch: -30, duration: 2 },
        { lng: 114.0288, lat: 22.5980, height: 550, heading: -30, pitch: -23, duration: 2 },
        { lng: 114.0268, lat: 22.6020, height: 400, heading: -33, pitch: -18, duration: 2 },
        { lng: 114.0240, lat: 22.6060, height: 350, heading: -35, pitch: -15, duration: 2 },
      ];

      for (let i = 0; i < flightPath.length; i++) {
        const point = flightPath[i];
        await new Promise((resolve) => {
          viewer.value.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(point.lng, point.lat, point.height),
            orientation: {
              heading: Cesium.Math.toRadians(point.heading),
              pitch: Cesium.Math.toRadians(point.pitch),
              roll: 0
            },
            duration: point.duration,
            easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
            complete: () => resolve(),
            cancel: () => resolve()
          });
        });
      }

      await new Promise((resolve) => {
        viewer.value.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(114.03, 22.58, 1800),
          orientation: {
            heading: Cesium.Math.toRadians(-10),
            pitch: Cesium.Math.toRadians(-30),
            roll: 0
          },
          duration: 3,
          easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
          complete: resolve
        });
      });
    } catch (error) {
      console.error('飞行漫游出错', error);
    } finally {
      viewer.value.scene.screenSpaceCameraController.enableInputs = true;
      isFlying = false;
    }
  }

  // ==================== 选址推荐 ====================
  // 生成绿色定位图标
  function drawPinCanvas(color) {
    const c = document.createElement('canvas');
    c.width = 28; c.height = 36;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(14, 12, 10, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(14, 36); ctx.lineTo(8, 18); ctx.lineTo(20, 18); ctx.closePath(); ctx.fill();
    return c;
  }

  function clearRecommendEntities() {
    recommendEntities.forEach(e => viewer.value.entities.remove(e));
    recommendEntities = [];
  }

  async function showRecommendedSites() {
    // 选址推荐依赖二维地图加载的数据
    if (!layers.value?.points?.visible || !vectorStore.points.length) {
      alert('未检测到设施点数据，请先在二维地图中加载显示设施点');
      return;
    }
    // 选择推荐类型
    const map = { '1': '幼儿园', '2': '小学', '3': '初中' };
    const input = prompt('选择推荐设施类型:\n1: 幼儿园(300m)\n2: 小学(500m)\n3: 初中(1000m)', '1');
    const type = map[input];
    if (!type) return;

    const radius = type === '幼儿园' ? 300 : type === '小学' ? 500 : 1000;
    const { data: sites } = await getRecommendedSites(type, radius);
    if (!sites?.length) { alert('暂无推荐选址'); return; }

    clearRecommendEntities();
    const color = '#fe18c9';
    sites.forEach((site, i) => {
      const entity = viewer.value.entities.add({
        position: Cesium.Cartesian3.fromDegrees(site.lng, site.lat, 10),
        billboard: {
          image: drawPinCanvas(color),
          scale: 1,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: `推荐 #${i + 1} (${Math.round(site.area)}㎡)`,
          font: '14px "Microsoft YaHei", Arial, sans-serif',
          fillColor: Cesium.Color.fromCssColorString(color),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          pixelOffset: new Cesium.Cartesian2(16, 0),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      recommendEntities.push(entity);
    });

    const last = sites[sites.length - 1];
    viewer.value.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(last.lng, last.lat, 5000),
      duration: 2
    });
  }

  async function handleAnalysisClick() {
    if (!viewer.value) return;

    if (!isAnalyzing.value) {
      await startAnalysisSession();
    } else {
      await analyzeNextFacility();
    }
  }

  async function startAnalysisSession() {
    // 分析依赖二维地图加载的数据
    if (!layers.value?.points?.visible || !vectorStore.points.length) {
      alert('未检测到设施点数据，请先在二维地图中加载显示设施点');
      return;
    }
    clearAnalysisGraphics();

    const facilities = educationSupplyData.filter(f =>
      ['幼儿园', '小学', '初中', '九年一贯制学校'].includes(f.type)
    );

    if (facilities.length === 0) {
      alert('没有可分析的教育设施');
      return;
    }

    analysisFacilities.value = facilities.slice(0, 10);
    currentAnalysisIndex.value = 0;
    isAnalyzing.value = true;
    isFlying = true;

    showAnalysisPanel();
    viewer.value.scene.screenSpaceCameraController.enableInputs = false;

    try {
      await analyzeCurrentFacility();
    } catch (error) {
      console.error('分析出错', error);
      resetAnalysisState();
    }
  }

  async function analyzeCurrentFacility() {
    const fac = analysisFacilities.value[currentAnalysisIndex.value];
    await flyToFacility(fac);
    await showAnalysisForFacility(fac);
  }

  async function showAnalysisForFacility(fac) {
    clearAnalysisGraphics();

    // 检查坐标有效性
    if (fac.lng == null || fac.lat == null || isNaN(fac.lng) || isNaN(fac.lat)) {
      console.warn('设施坐标无效，跳过可视化:', fac.name)
      showSupplyDemandPanel(fac)
      return
    }

    let radius = 0;
    if (fac.type === '幼儿园') radius = 300;
    else if (fac.type === '小学') radius = 500;
    else if (fac.type === '初中') radius = 1000;
    else if (fac.type === '九年一贯制学校') radius = 1000;

    const minHeight = 0;
    const maxHeight = 600;
    const minScale = 0;
    const maxScale = 6000;

    const supply = fac.supply_capacity || fac.scale || 0
    const demand = fac.estimated_demand || fac.demand || 0

    let actualHeight = minHeight + (supply - minScale) / (maxScale - minScale) * (maxHeight - minHeight);
    actualHeight = Math.min(maxHeight, Math.max(minHeight, actualHeight));

    let demandHeight = minHeight + (demand - minScale) / (maxScale - minScale) * (maxHeight - minHeight);
    demandHeight = Math.min(maxHeight, Math.max(minHeight, demandHeight));

    let color = '#808080';
    if (fac.status === 'sufficient') color = '#4caf50';
    else if (fac.status === 'balanced') color = '#ffc107';
    else if (fac.status === 'insufficient') color = '#f44336';

    drawDualColorColumn(fac.lng, fac.lat, actualHeight, demandHeight, supply, demand, fac.name, analysisEntities);
    drawServiceRadius(Cesium, viewer.value, fac.lng, fac.lat, radius, color, analysisEntities);

    showSupplyDemandPanel(fac);
  }

  function drawDualColorColumn(lng, lat, actualHeight, demandHeight, actualScale, demandScale, name, analysisEntities) {
    const splitAngle = -35 * Math.PI / 180;
    const gap = 5;
    const gapOffset = gap / 2 / 111000;

    const greenLng = lng - gapOffset;
    const greenLat = lat - gapOffset;
    const redLng = lng + gapOffset;
    const redLat = lat + gapOffset;

    const supplyColumn = drawHalfCylinder(Cesium, viewer.value, greenLng, greenLat, actualHeight, '#4caf50', splitAngle - Math.PI, splitAngle);
    const demandColumn = drawHalfCylinder(Cesium, viewer.value, redLng, redLat, demandHeight, '#f44336', splitAngle, splitAngle + Math.PI);

    const horizontalOffset = 5;
    const lngOffset = horizontalOffset / 111000;

    const supplyLabel = viewer.value.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lng - lngOffset, lat, actualHeight + 30),
      label: {
        text: `${actualScale}`,
        font: 'bold 16px "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#4caf50'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        horizontalOrigin: Cesium.HorizontalOrigin.RIGHT,
        pixelOffset: new Cesium.Cartesian2(-5, 0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });

    const demandLabel = viewer.value.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lng + lngOffset, lat, demandHeight + 30),
      label: {
        text: `${demandScale}`,
        font: 'bold 16px "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#f44336'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        pixelOffset: new Cesium.Cartesian2(5, 0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });

    analysisEntities.push(supplyColumn, demandColumn, supplyLabel, demandLabel);
  }

  function showSupplyDemandPanel(fac) {
    const container = document.querySelector('.analysis-content');
    if (!container) return;

    let html = '';
    if (!fac || fac.status === 'no_data') {
      html = '<p style="color: #aaa; text-align: center;">暂无数据</p>';
    } else {
      const supply = fac.supply_capacity || fac.scale || 0
      const demand = fac.estimated_demand || 0
      const population = fac.estimated_population || 0
      const ratio = fac.supply_demand_ratio

      html = `<p class="school-name">${fac.name}</p>`;
      html += `<p><strong>学校类型：</strong> ${fac.type}</p>`;
      html += `<p><strong>实际学位：</strong> ${supply} 个</p>`;
      html += `<p><strong>覆盖人口：</strong> ${population.toLocaleString()} 人</p>`;

      if (fac.type === '九年一贯制学校') {
        html += `<p><strong>总需求：</strong> ${demand} 学位</p>`;
      } else {
        html += `<p><strong>需求学位：</strong> ${demand} 个</p>`;
      }

      const ratioColor = ratio >= 1.1 ? '#4caf50' : (ratio >= 0.9 ? '#ffc107' : '#f44336');
      html += `<p><strong>供需比：</strong> <span style="color: ${ratioColor}; font-weight: bold;">${ratio || '-'}</span></p>`;

      let statusText = '';
      if (fac.status === 'sufficient') statusText = '充足 ✅';
      else if (fac.status === 'balanced') statusText = '平衡 ⚠️';
      else if (fac.status === 'insufficient') statusText = '不足 ❌';
      html += `<p><strong>供需评价：</strong> ${statusText}</p>`;
    }
    container.innerHTML = html;
  }

  function flyToFacility(fac) {
    return new Promise((resolve) => {
      viewer.value.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(fac.lng + 0.013, fac.lat - 0.013, 1500),
        orientation: {
          heading: Cesium.Math.toRadians(-45),
          pitch: Cesium.Math.toRadians(-35),
          roll: 0
        },
        duration: 1.5,
        complete: resolve,
        cancel: resolve
      });
    });
  }

  async function analyzeNextFacility() {
    const nextIndex = currentAnalysisIndex.value + 1;
    if (nextIndex < analysisFacilities.value.length) {
      currentAnalysisIndex.value = nextIndex;
      await analyzeCurrentFacility();
    } else {
      await finishAnalysis();
    }
  }

  async function finishAnalysis() {
    await new Promise((resolve) => {
      viewer.value.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(114.03, 22.58, 1800),
        orientation: {
          heading: Cesium.Math.toRadians(-10),
          pitch: Cesium.Math.toRadians(-30),
          roll: 0
        },
        duration: 2,
        complete: resolve
      });
    });

    clearAnalysisGraphics();
    hideAnalysisPanel();
    document.querySelector('.analysis-content').innerHTML = '<p style="color: #aaa; text-align: center;">分析中...</p>';
    resetAnalysisState();
  }

  function resetAnalysisState() {
    isAnalyzing.value = false;
    currentAnalysisIndex.value = 0;
    analysisFacilities.value = [];
    isFlying = false;
    viewer.value.scene.screenSpaceCameraController.enableInputs = true;
  }

  function clearAnalysisGraphics() {
    clearRecommendEntities();
    rippleIntervals.forEach(interval => clearInterval(interval));
    rippleIntervals.length = 0;

    // 移除所有分析图形（柱体、波纹、标注）
    const entities = viewer.value?.entities;
    if (entities) {
      const toRemove = [];
      entities.values.forEach(entity => {
        // 柱体：有 polygon 且 extrudedHeight 存在
        // 波纹：有 ellipse
        // 标注：有 label 且文本是纯数字
        if ((entity.polygon && entity.polygon.extrudedHeight !== undefined) ||
          entity.ellipse ||
          (entity.label && /^\d+$/.test(entity.label.text))) {
          toRemove.push(entity);
        }
      });
      toRemove.forEach(entity => entities.remove(entity));
    }

    analysisEntities = [];
  }

  function showAnalysisPanel() {
    const panel = document.querySelector('.analysis-panel');
    if (panel) panel.style.display = 'block';
  }

  function hideAnalysisPanel() {
    const panel = document.querySelector('.analysis-panel');
    if (panel) panel.style.display = 'none';
  }

  function showCesiumPopup(properties, screenPosition) {
    if (!cesiumPopupDiv) {
      cesiumPopupDiv = document.createElement('div');
      cesiumPopupDiv.className = 'cesium-popup-3d';
      document.body.appendChild(cesiumPopupDiv);

      cesiumPopupCloseBtn = document.createElement('button');
      cesiumPopupCloseBtn.className = 'cesium-popup-close-3d';
      cesiumPopupCloseBtn.innerHTML = '×';
      cesiumPopupCloseBtn.onclick = closeCesiumPopup;
      cesiumPopupDiv.appendChild(cesiumPopupCloseBtn);
    }

    // 构建内容 HTML
    let html = `<h4>${properties.name || '未命名'}</h4>`;
    if (properties.level !== undefined) {
      // 设施点：显示属性 + 服务覆盖分析按钮
      html += `<p><strong>设施级别：</strong>${properties.level || '-'}</p>`;
      html += `<p><strong>设施类型：</strong>${properties.type || '-'}</p>`;
      html += `<p><strong>建筑面积：</strong>${properties.floor_area || 0}平方米</p>`;
      html += `<p><strong>服务规模：</strong>${properties.scale || 0}人</p>`;
      html += `<button class="analysis-btn" id="service-btn">服务覆盖分析</button>`;
    } else if (properties.site_area !== undefined) {
      html += `<p><strong>用地类型：</strong>${properties.type || '-'}</p>`;
      html += `<p><strong>用地面积：</strong>${properties.site_area || 0}平方米</p>`;
    } else {
      if (properties.type) html += `<p><strong>建筑类型：</strong>${properties.type}</p>`;
      if (properties.height) html += `<p><strong>建筑高度：</strong>${properties.height}米</p>`;
      if (properties.up_floor) html += `<p><strong>地上层数：</strong>${properties.up_floor}层</p>`;
      if (properties.down_floor) html += `<p><strong>地下层数：</strong>${properties.down_floor}层</p>`;
      if (properties.floor_area) html += `<p><strong>建筑面积：</strong>${properties.floor_area}平方米</p>`;
    }

    // 查找或创建内容包装器
    let contentWrapper = cesiumPopupDiv.querySelector('.popup-content-wrapper-3d');
    if (!contentWrapper) {
      contentWrapper = document.createElement('div');
      contentWrapper.className = 'popup-content-wrapper-3d';
      // 将包装器插入到关闭按钮之前
      cesiumPopupDiv.insertBefore(contentWrapper, cesiumPopupCloseBtn);
    }

    // 更新内容
    contentWrapper.innerHTML = html;

    // 如果是设施点，绑定服务覆盖分析按钮
    const btn = cesiumPopupDiv.querySelector('#service-btn');
    if (btn) {
      btn.onclick = () => {
        const [lng, lat] = properties.geometry?.coordinates || [];
        if (!lng || !lat) return;
        const radius = getRadiusByType(properties.type);
        clearAnalysisGraphics();
        drawServiceRadius(Cesium, viewer.value, lng, lat, radius, '#2196F3', analysisEntities);
        viewer.value.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lng, lat, radius * 6),
          duration: 2.5
        });
        closeCesiumPopup();

        // 按 Esc 退出覆盖分析
        const onEsc = (e) => {
          if (e.key === 'Escape') {
            clearAnalysisGraphics();
            document.removeEventListener('keydown', onEsc);
          }
        };
        document.addEventListener('keydown', onEsc);
      };
    }

    // 定位并显示
    cesiumPopupDiv.style.left = `${screenPosition.x + 15}px`;
    cesiumPopupDiv.style.top = `${screenPosition.y}px`;
    cesiumPopupDiv.style.display = 'block';
  }

  function closeCesiumPopup() {
    if (cesiumPopupDiv) {
      cesiumPopupDiv.style.display = 'none';
    }
  }

  // 回到初始视角（中止所有操作）
  function resetView() {
    clearAnalysisGraphics();
    clearRecommendEntities();
    hideAnalysisPanel();
    resetAnalysisState();
    viewer.value.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(114.03, 22.58, 1800),
      orientation: {
        heading: Cesium.Math.toRadians(-10),
        pitch: Cesium.Math.toRadians(-30),
        roll: 0
      },
      duration: 1.5
    });
  }

  // ==================== 服务半径覆盖 ====================
  let radiusEntities = [];

  function clearRadiusEntities() {
    radiusEntities.forEach(e => viewer.value?.entities.remove(e));
    radiusEntities = [];
  }

  function drawServiceRadii(filterType) {
    clearRadiusEntities();
    const pts = vectorStore.points;
    if (!pts.length || !layers.value?.points?.visible) return;

    const sel = layers.value.points.selectedType;
    let filtered = sel === '全部类型' ? pts : pts.filter(p => p.type === sel);
    if (filterType) filtered = filtered.filter(p => p.type === filterType);

    filtered.forEach(p => {
      const [lng, lat] = p.geometry.coordinates;
      const radius = getRadiusByType(p.type) || 300;
      if (!radius) return;
      const e = viewer.value.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lng, lat, 0),
        ellipse: {
          semiMinorAxis: radius, semiMajorAxis: radius,
          material: Cesium.Color.fromCssColorString('rgba(48,158,255,0.12)'),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('rgba(48,158,255,0.35)'),
          height: 1.5, extrudedHeight: 4
        }
      });
      radiusEntities.push(e);
    });
  }

  function toggleServiceRadii() {
    if (radiusEntities.length) { clearRadiusEntities(); return; }
    if (!layers.value?.points?.visible) { alert('请先在二维地图中加载显示设施点'); return; }
    const TYPE_MAP = { '1': '幼儿园', '2': '小学', '3': '初中', '4': '九年一贯制学校', '5': '医院' };
    const input = prompt(
      '选择覆盖分析类型:\n1: 幼儿园(300m)\n2: 小学(500m)\n3: 初中(1000m)\n' +
      '4: 九年一贯制(1000m)\n5: 医院(1000m)\n其他: 显示当前筛选全部', '1');
    const type = TYPE_MAP[input];
    if (!type && input !== null) { drawServiceRadii(); return; }
    if (!type) return;
    drawServiceRadii(type);
  }

  return {
    viewer,
    cesiumInitialized,
    loadCesium,
    toggleLayer,
    onTypeChange,
    startFlythrough,
    handleAnalysisClick,
    loadPointsAndLands,
    closeCesiumPopup,
    analysisButtonText,
    showRecommendedSites,
    resetView,
    toggleServiceRadii,
  };
}