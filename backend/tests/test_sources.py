from app.sources import _parse_horizons_response, _slope_from_cardinal_samples


def test_slope_uses_central_difference_and_returns_degrees():
    slope = _slope_from_cardinal_samples(
        north_m=20,
        south_m=-20,
        east_m=10,
        west_m=-10,
        north_south_spacing_m=200,
        east_west_spacing_m=200,
    )

    assert round(slope, 3) == 12.604


def test_parse_horizons_csv_table_and_de441_model():
    payload = {
        "signature": {"version": "1.2"},
        "result": """
Target body name: Sun (10) {source: DE441}
$$SOE
 2027-Mar-14 06:00, ,i, 241.197254, -1.097653, 0.99326490005374, 1.3845965,
 2027-Mar-14 06:10, ,i, 241.112614, -1.098538, 0.99327045428997, 1.3850763,
$$EOE
""",
    }

    result = _parse_horizons_response(payload)

    assert result["version"] == "1.2"
    assert result["model"] == "DE441"
    assert result["samples"][0]["time"] == "2027-03-14T06:00:00Z"
    assert result["samples"][0]["azDeg"] == 241.197254
    assert result["samples"][0]["elDeg"] == -1.097653
    assert result["samples"][0]["distanceKm"] > 140_000_000
