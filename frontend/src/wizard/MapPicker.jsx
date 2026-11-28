import React from 'react';
import { MapContainer, TileLayer, Marker, Circle, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import icon from 'leaflet/dist/images/marker-icon.png';
import shadow from 'leaflet/dist/images/marker-shadow.png';

const pin = L.icon({ iconUrl: icon, shadowUrl: shadow, iconSize: [25, 41], iconAnchor: [12, 41] });

function Clicker({ onPick }) {
  useMapEvents({ click: (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

export default function MapPicker({ value, radiusKm, onPick }) {
  const center = value?.lat ? [value.lat, value.lng] : [30.901, 75.857]; // Ludhiana
  return (
    <MapContainer center={center} zoom={11} style={{ height: 340, borderRadius: 12 }} scrollWheelZoom>
      <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <Clicker onPick={onPick} />
      {value?.lat && <><Marker position={center} icon={pin} /><Circle center={center} radius={radiusKm * 1000} pathOptions={{ color: '#b8142f' }} /></>}
    </MapContainer>
  );
}
