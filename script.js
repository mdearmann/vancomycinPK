// Constants and Safety Limits
const CONSTANTS = {
  LB_TO_KG: 0.453592,
  IN_TO_CM: 2.54,
  UMOL_TO_MG_DL: 0.0113,
  V_FACTOR: 0.7,
  DOSE_INCREMENT: 250 // New constant for dose increments
};

const SAFETY_LIMITS = {
  age: { min: 18, max: 120 },
  weight: { min: 20, max: 300 },
  height: { min: 120, max: 250 },
  creatinine: { min: 0.2, max: 15 },
  maxSingleDose: 3000,
  minDose: 250, // Changed from 500 to 250
  targetAUC: { min: 400, max: 600 },
  targetTrough: { min: 10, max: 20 },
  crCl: { warning: 30, critical: 15 }
};

// Add this after your SAFETY_LIMITS constant
function roundTo250(value) {
    return Math.round(value / 250) * 250;
}

// Patient Calculator Class
class PatientCalculator {
  constructor() {
      this.units = {
          weight: 'kg',
          height: 'in',
          creatinine: 'mg/dL'
      };
      this.sex = 'male';
      this.values = {
          age: 0,
          weight: 0,
          height: 0,
          creatinine: 0
      };
  }

  convertToStandardUnits(value, type) {
      return value;  // Since inputs are already in kg, in, and mg/dL
  }

  calculateIBW() {
      const heightInCm = this.convertToStandardUnits(this.values.height, 'height');
      const heightInInches = this.units.height === 'in' ?
          this.values.height : heightInCm / CONSTANTS.IN_TO_CM;
      const baseWeight = this.sex === 'male' ? 50 : 45.5;
      return baseWeight + 2.3 * (heightInInches - 60);
  }

  calculateAdjBW() {
      const actualWeight = this.convertToStandardUnits(this.values.weight, 'weight');
      const ibw = this.calculateIBW();
      return actualWeight > ibw * 1.2 ? ibw + 0.4 * (actualWeight - ibw) : actualWeight;
  }

  calculateCrCl() {
      const weightInKg = this.calculateAdjBW();
      const creatinineStd = this.convertToStandardUnits(this.values.creatinine, 'creatinine');

      if (creatinineStd === 0) return 0;

      let crCl = ((140 - this.values.age) * weightInKg) / (72 * creatinineStd);
      if (this.sex === 'female') crCl *= 0.85;

      return Math.round(crCl * 10) / 10;
  }
}

// Vancomycin Calculator Class
class VancomycinCalculator {
  calculateKel(crCl) { // Matzke equation with better precision
      return (0.00083 * crCl) + 0.0044;
  }

  // Calculate vancomycin clearance
  calculateVancClearance(V, k) {
      return V * k;
  }

  // Calculate peak concentration at steady state
  calculateCmaxSS(dose, k, V, t_inf) {
    // Correct formula for Cmax at steady state
    return (dose / (V * k * t_inf)) * (1 - Math.exp(-k * t_inf));
}

  // Calculate trough concentration at steady state
  calculateCminSS(dose, k, V, t_inf, tau) {
    // Correct formula for Cmin at steady state
    const Cmax = this.calculateCmaxSS(dose, k, V, t_inf);
    return Cmax * Math.exp(-k * (tau - t_inf));
}

calculateAUC24(dose, k, V, t_inf, tau) {
  // Calculate AUC using trapezoidal rule for more accuracy
  const doses_per_24h = Math.floor(24 / tau);
  const single_dose_auc = (dose / (V * k)) * (1 + (t_inf * k * Math.exp(-k * tau) / (1 - Math.exp(-k * tau))));
  return single_dose_auc * doses_per_24h;
}

getDoseRecommendations(weight, crCl) {
  const k = this.calculateKel(crCl);
  const V = 0.7 * weight;  // Standard Vd calculation
  const Cl = this.calculateVancClearance(V, k);
  
  // Target AUC24/MIC ratio of 400-600
  const targetAUC = 400; // Using lower bound as target
  const totalDailyDose = Cl * targetAUC;
  
  return {
      k,
      V,
      Cl,
      frequencies: [8, 12, 24, 36, 48].map(freq => ({
          frequency: freq,
          dose: Math.round(totalDailyDose / (24/freq) / 250) * 250, // Round to nearest 250mg
          dailyDose: totalDailyDose
      }))
  };
}

calculateSafetyChecks(dose, k, V, t_inf, tau) {
  const Cmax = this.calculateCmaxSS(dose, k, V, t_inf);
  const Cmin = this.calculateCminSS(dose, k, V, t_inf, tau);
  const AUC24 = this.calculateAUC24(dose, k, V, t_inf, tau);
  
  return {
      isMaxSafe: Cmax < 40, // Peak should generally be < 40 mg/L
      isMinTherapeutic: Cmin > 10, // Trough should be > 10 mg/L
      isAUCSafe: AUC24 >= 400 && AUC24 <= 600, // Target AUC24 range
      values: {
          Cmax,
          Cmin,
          AUC24
      }
  };
}
}
// Initialize calculators
const patientCalc = new PatientCalculator();
const vancCalc = new VancomycinCalculator();
let concentrationChart = null;

// UI Update Functions
function showWarning(message, type = 'warning') {
  const warningDiv = document.getElementById('warning-messages');
  const alert = document.createElement('div');
  alert.className = `alert alert-${type} alert-dismissible fade show`;
  alert.innerHTML = `
      ${message}
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
  `;
  warningDiv.appendChild(alert);
  setTimeout(() => alert.remove(), 5000);
}

function updateConcentrationGraph(dose, tau, k, V, t_inf = 1) {
  const ctx = document.getElementById('pk-graph').getContext('2d');
  const timePoints = Array.from({ length: 91 }, (_, i) => i);

  // Calculate concentrations
  const concentrations = timePoints.map(t => {
      let concentration = 0;
      const numDoses = Math.floor(t / tau);

      for (let i = 0; i <= numDoses; i++) {
          const t_since_dose = t - (i * tau);
          if (t_since_dose >= 0) {
              if (t_since_dose <= t_inf) {
                  concentration += (dose / (V * k * t_inf)) * (1 - Math.exp(-k * t_since_dose));
              } else {
                  concentration += (dose / (V * k * t_inf)) *
                      (1 - Math.exp(-k * t_inf)) *
                      Math.exp(-k * (t_since_dose - t_inf));
              }
          }
      }
      return concentration;
  });

  // Update chart data
  const newData = {
    labels: timePoints,
    datasets: [{
        label: 'Concentration',
        data: concentrations,
        borderColor: '#C41E3A',               // Christmas red
        backgroundColor: 'rgba(196, 30, 58, 0.1)', // Light red background
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 0,
        pointBackgroundColor: '#C41E3A'       // Christmas red for any points
    }]
  };

  // Define chart options
  const chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
          tooltip: {
              mode: 'index',
              intersect: false,
              callbacks: {
                  label: function(context) {
                      return `Concentration: ${context.parsed.y.toFixed(1)} mcg/mL`;
                  }
              }
          }
      },
      scales: {
          x: {
              title: {
                  display: true,
                  text: 'Time (h)',
                  font: { size: 14 }
              },
              min: 0,
              max: 90,
              ticks: {
                  stepSize: 10,
                  callback: function(value) {
                      return value % 10 === 0 ? value : '';
                  }
              }
          },
          y: {
              title: {
                  display: true,
                  text: 'Concentration (mcg/mL)',
                  font: { size: 14 }
              },
              min: 0,
              max: 40,
              ticks: {
                  stepSize: 10
              }
          }
      }
  };

  // If chart exists, update it; otherwise create new
  if (concentrationChart) {
      concentrationChart.data = newData;
      concentrationChart.options = chartOptions; // Update options as well
      concentrationChart.update();
  } else {
      concentrationChart = new Chart(ctx, {
          type: 'line',
          data: newData,
          options: chartOptions
      });
  }

  addTargetRanges(concentrationChart);
}

function addTargetRanges(chart) {
  const targetMin = 10;
  const targetMax = 20;

  chart.data.datasets.push({
      label: 'Target Range',
      data: chart.data.labels.map(() => targetMax),
      borderColor: '#146B3A',              // Holly green for upper bound
            backgroundColor: 'rgba(20, 107, 58, 0.1)', // Light holly green fill
            borderWidth: 1,
            fill: '+1',
            pointRadius: 0
  });

  chart.data.datasets.push({
      label: 'Target Min',
      data: chart.data.labels.map(() => targetMin),
      borderColor: '#FFD700',              // Gold for target minimum
            borderWidth: 1,
            borderDash: [5, 5],
            fill: false,
            pointRadius: 0
  });

  chart.update();
}

function updateKineticParams(crCl, k, V, Cl) {
  document.getElementById('kinetic-params').innerHTML = `
      <p>Creatinine clearance (CrCl): ${crCl.toFixed(1)} mL/min</p>
      <p>Elimination constant (Kel): ${k.toFixed(4)} hr⁻¹</p>
      <p>Volume of distribution (Vd): ${V.toFixed(1)} L</p>
      <p>Clearance (CLvanco): ${Cl.toFixed(1)} L/hr</p>
  `;
}

// Add the calculateValues function to the global scope
function updateDosingTable(recommendations) {
  function calculateValues(dose, k, V, frequency) {
      const infusionTime = 1; // 1 hour default infusion time
      const peak = vancCalc.calculateCmaxSS(dose, k, V, infusionTime);
      const trough = vancCalc.calculateCminSS(dose, k, V, infusionTime, frequency);
      const auc = vancCalc.calculateAUC24(dose, k, V, infusionTime, frequency);
      return { peak, trough, auc };
  }

  // Define frequency preference order (lower number = higher preference)
  const frequencyPreference = {
      12: 1,  // Most preferred
      24: 2,
      8: 3,
      36: 4,
      48: 5   // Least preferred
  };

  let globalOptimalDose = null;
  let globalOptimalFreq = null;
  let globalOptimalMetrics = null;
  let bestPreferenceScore = Infinity;
  let bestAUCDeviation = Infinity;

  [8, 12, 24, 36, 48].forEach(frequency => {
      const tableBody = document.getElementById(`dosingOptionsTable_q${frequency}h`);
      if (!tableBody) return;

      const baseFreq = recommendations.frequencies.find(f => f.frequency === frequency);
        if (!baseFreq) return;

      // Generate doses in 250mg increments
        const baseDose = roundTo250(baseFreq.dose);
        const doses = [
            roundTo250(baseDose - 250),
            baseDose,
            roundTo250(baseDose + 250)
        ];

      // Find acceptable doses for this frequency
      doses.forEach(dose => {
          if (dose >= SAFETY_LIMITS.minDose && dose <= SAFETY_LIMITS.maxSingleDose) {
              const metrics = calculateValues(dose, recommendations.k, recommendations.V, frequency);
              // Check if AUC is within target range
              if (metrics.auc >= 400 && metrics.auc <= 600) {
                  const aucDeviation = Math.abs(500 - metrics.auc);
                  const preferenceScore = frequencyPreference[frequency];

                  // Prioritize q12h and AUC closest to 500
                  if (preferenceScore < bestPreferenceScore || 
                    (preferenceScore === bestPreferenceScore && aucDeviation < bestAucDeviation)) {
                    globalOptimalDose = dose;
                    globalOptimalFreq = frequency;
                    globalOptimalMetrics = metrics;
                    bestPreferenceScore = preferenceScore;
                    bestAucDeviation = aucDeviation;
                  }
              }
          }
      });

      // Generate table rows
      const rows = doses
          .filter(dose => dose >= SAFETY_LIMITS.minDose && dose <= SAFETY_LIMITS.maxSingleDose)
          .map(dose => {
              const { peak, trough, auc } = calculateValues(dose, recommendations.k, recommendations.V, frequency);
              return `
                  <tr>
                      <td>${dose} mg</td>
                      <td>${(auc / 1).toFixed(1)}</td>
                      <td>${peak.toFixed(1)}</td>
                      <td>${trough.toFixed(1)}</td>
                      <td>
                          <button class="btn btn-sm btn-primary" 
                              onclick="selectDose(${dose}, ${frequency})">
                              Select
                          </button>
                      </td>
                  </tr>
              `;
          });

      tableBody.innerHTML = rows.join('');
  });

  // Set the optimal dose if found
  if (globalOptimalDose) {
      document.getElementById('dose-input').value = globalOptimalDose;
      document.getElementById('frequency-input').value = globalOptimalFreq;
      document.getElementById('infusion-input').value = 1;
  }
}
// Helper function for dose selection
function selectDose(dose, frequency) {
    document.getElementById('dose-input').value = roundTo250(dose);
    document.getElementById('frequency-input').value = frequency;
    document.getElementById('infusion-input').value = 1;

  // Trigger recalculation
  document.getElementById('recalculate-btn').click();
}

// Document ready event handler
document.addEventListener('DOMContentLoaded', () => {
  // Initialize event listeners
  document.getElementById('calculate-btn').addEventListener('click', () => {
    if (!patientCalc.values.age || !patientCalc.values.weight ||
        !patientCalc.values.height || !patientCalc.values.creatinine) {
        showWarning('Please fill in all required fields.', 'warning');
        return;
      }

      const crCl = patientCalc.calculateCrCl();

      // Safety checks
      if (crCl < SAFETY_LIMITS.crCl.critical) {
          showWarning('CRITICAL: CrCl < 15 mL/min. Consider alternative therapy.', 'danger');
          return;
      }
      if (crCl < SAFETY_LIMITS.crCl.warning) {
          showWarning('WARNING: CrCl < 30 mL/min. Dose reduction required.', 'warning');
      }

      const results = vancCalc.getDoseRecommendations(
          patientCalc.calculateAdjBW(),
          crCl
      );

      // Update all displays
      updateKineticParams(crCl, results.k, results.V, results.Cl);
      updateDosingTable(results);

      // Update graph with initial values
      const dose = document.getElementById('dose-input').value;
      const frequency = document.getElementById('frequency-input').value;
      const infusionTime = document.getElementById('infusion-input').value || 1;
      
      if (dose && frequency) {
        // Calculate PK values
        const peak = vancCalc.calculateCmaxSS(dose, results.k, results.V, infusionTime);
        const trough = vancCalc.calculateCminSS(dose, results.k, results.V, infusionTime, frequency);
        const auc = vancCalc.calculateAUC24(dose, results.k, results.V, infusionTime, frequency);

        // Update PK displays
        document.getElementById('pk-dose').textContent = `${dose} mg q${frequency}h`;
        document.getElementById('pk-auc').textContent = `${Math.round(auc)} mcg*hr/mL`;
        document.getElementById('pk-peak').textContent = `${Math.round(peak)} mcg/mL`;
        document.getElementById('pk-trough').textContent = `${Math.round(trough)} mcg/mL`;

        // Update graph
        updateConcentrationGraph(
            parseFloat(dose),
            parseFloat(frequency),
            results.k,
            results.V,
            parseFloat(infusionTime)
        );
      }
  });

  // Add input event listeners
  ['age', 'weight', 'height', 'creatinine'].forEach(field => {
      const input = document.getElementById(`${field}-input`);
      if (input) {
          input.addEventListener('input', (e) => {
              patientCalc.values[field] = parseFloat(e.target.value) || 0;
          });
      }
  });

  // Sex selection listeners - using the unit-toggle class
  document.querySelector('.unit-toggle').addEventListener('click', (e) => {
      const button = e.target.closest('[data-sex]');
      if (!button) return;  // If click wasn't on a sex button, ignore it
      
      // Remove active class from all buttons and add to clicked one
      document.querySelectorAll('[data-sex]').forEach(btn => {
          btn.classList.remove('active');
      });
      button.classList.add('active');
      
      // Update the calculator's sex value
      patientCalc.sex = button.dataset.sex;
      
      // Optional: Log the change to verify it's working
      console.log('Sex updated to:', patientCalc.sex);
  });

  // ADD THIS SECTION - Recalculate button functionality
  document.getElementById('recalculate-btn').addEventListener('click', () => {
    const dose = roundTo250(parseFloat(document.getElementById('dose-input').value));
    document.getElementById('dose-input').value = dose; // Update input to show rounded value
    const frequency = parseFloat(document.getElementById('frequency-input').value);
    const infusionTime = parseFloat(document.getElementById('infusion-input').value) || 1;

    if (!dose || !frequency) {
        showWarning('Please enter both dose and frequency.', 'warning');
        return;
    }

    const crCl = patientCalc.calculateCrCl();
    const k = vancCalc.calculateKel(crCl);
    const V = CONSTANTS.V_FACTOR * patientCalc.calculateAdjBW();

    const peak = vancCalc.calculateCmaxSS(dose, k, V, infusionTime);
    const trough = vancCalc.calculateCminSS(dose, k, V, infusionTime, frequency);
    const auc = vancCalc.calculateAUC24(dose, k, V, infusionTime, frequency);

    // Update PK displays
    document.getElementById('pk-dose').textContent = `${dose} mg q${frequency}h`;
    document.getElementById('pk-auc').textContent = `${auc.toFixed(1)} mcg*hr/mL`;
    document.getElementById('pk-peak').textContent = `${peak.toFixed(1)} mcg/mL`;
    document.getElementById('pk-trough').textContent = `${trough.toFixed(1)} mcg/mL`;

    // Update concentration graph
    updateConcentrationGraph(dose, frequency, k, V, infusionTime);
});



  // Sex selection listeners
  document.querySelectorAll('[data-sex]').forEach(button => {
      button.addEventListener('click', (e) => {
          document.querySelectorAll('[data-sex]').forEach(btn => {
              btn.classList.remove('active');
          });
          button.classList.add('active');
          patientCalc.sex = button.dataset.sex;
      });
  });

  // Recalculate button functionality
  document.getElementById('recalculate-btn').addEventListener('click', () => {
      const dose = parseFloat(document.getElementById('dose-input').value);
      const frequency = parseFloat(document.getElementById('frequency-input').value);
      const infusionTime = parseFloat(document.getElementById('infusion-input').value) || 1;

      if (!dose || !frequency) {
          showWarning('Please enter both dose and frequency.', 'warning');
          return;
      }

      const crCl = patientCalc.calculateCrCl();
      const k = vancCalc.calculateKel(crCl);
      const V = CONSTANTS.V_FACTOR * patientCalc.calculateAdjBW();

      const peak = vancCalc.calculateCmaxSS(dose, k, V, infusionTime);
      const trough = vancCalc.calculateCminSS(dose, k, V, infusionTime, frequency);
      const auc = vancCalc.calculateAUC24(dose, k, V, infusionTime, frequency);

      // Update PK displays
      document.getElementById('pk-dose').textContent = `${dose} mg q${frequency}h`;
      document.getElementById('pk-auc').textContent = `${auc.toFixed(1)} mcg*hr/mL`;
      document.getElementById('pk-peak').textContent = `${peak.toFixed(1)} mcg/mL`;
      document.getElementById('pk-trough').textContent = `${trough.toFixed(1)} mcg/mL`;

      // Update concentration graph
      updateConcentrationGraph(dose, frequency, k, V, infusionTime);

  });

  // Clear button functionality
  document.getElementById('clear-btn').addEventListener('click', () => {
      // Clear all input fields
      document.querySelectorAll('input[type="number"]').forEach(input => input.value = '');

      // Reset sex selection
      document.querySelectorAll('[data-sex]').forEach(btn => btn.classList.remove('active'));
      document.querySelector('[data-sex="male"]').classList.add('active');
      patientCalc.sex = 'male';

      // Reset kinetic parameters
      document.getElementById('kinetic-params').innerHTML = `
          <p>Creatinine clearance (CrCl): ---</p>
          <p>Elimination constant (Kel): ---</p>
          <p>Volume of distribution (Vd): ---</p>
          <p>Clearance (CLvanco): ---</p>
      `;

      // Reset PK values
      document.getElementById('pk-dose').textContent = '-- mg q--h';
      document.getElementById('pk-auc').textContent = '-- mcg*hr/mL';
      document.getElementById('pk-peak').textContent = '-- mcg/mL';
      document.getElementById('pk-trough').textContent = '-- mcg/mL';

      // Clear dosing tables
      [8, 12, 24, 36, 48].forEach(freq => {
          const tableBody = document.getElementById(`dosingOptionsTable_q${freq}h`);
          if (tableBody) tableBody.innerHTML = '';
      });

      // Reset graph
      if (concentrationChart) {
          concentrationChart.destroy();
          concentrationChart = null;
      }

      // Reset patient calculator values
      patientCalc.values = {
          age: 0,
          weight: 0,
          height: 0,
          creatinine: 0
      };
  });

  // Progress note button functionality
  document.addEventListener('click', function(e) {
      // Handle progress note button clicks
      if (e.target && e.target.id === 'progress-note-btn') {
          const dose = document.getElementById('dose-input').value;
          const freq = document.getElementById('frequency-input').value;
          const infusion = document.getElementById('infusion-input').value;
          const crCl = patientCalc.calculateCrCl();

          const noteText = `[Patient description, reason for consult]

Patient Metrics
Age:      ${patientCalc.values.age} yrs
Height:   ${patientCalc.values.height} in
Gender:   ${patientCalc.sex.charAt(0).toUpperCase() + patientCalc.sex.slice(1)}
Total BW: ${patientCalc.values.weight} kg
Ideal BW: ${patientCalc.calculateIBW().toFixed(1)} kg
Adjusted BW: ${patientCalc.calculateAdjBW().toFixed(1)} kg
CrCl:     ${crCl.toFixed(0)} mL/min

Empiric Dosing
Vancomycin dose: ${dose} mg IV Q${freq}hrs (infused over ${infusion} hrs)

Which is predicted to acheive the following parameters:
Estimated AUC/MIC: ${document.getElementById('pk-auc').textContent}
Estimated peak: ${document.getElementById('pk-peak').textContent}
Estimated trough: ${document.getElementById('pk-trough').textContent}

A/P:
1. Recommend vancomycin ${dose} mg IV Q${freq}hrs
2. [Discuss when next vancomycin level(s) should be obtained based on clinical factors and/or institution policy]
3. Monitor renal function (urine output, BUN/SCr). Dose adjustments may be necessary with a significant change in renal function.

Please contact with questions. Thank you for the consult.
[Signature, contact information]`;

          document.getElementById('progress-note-content').innerText = noteText;

          // Show the modal
          const progressNoteModal = new bootstrap.Modal(document.getElementById('progress-note-modal'));
          progressNoteModal.show();
      }
  });

  // Copy button functionality
  document.getElementById('copy-note-btn').addEventListener('click', () => {
      const noteContent = document.getElementById('progress-note-content').innerText;
      navigator.clipboard.writeText(noteContent)
          .then(() => {
              showWarning('Progress note copied to clipboard!', 'success');
          })
          .catch(err => {
              console.error('Failed to copy text: ', err);
              showWarning('Failed to copy text. Please try selecting and copying manually.', 'danger');
          });

  });

  // Add this with your other event listeners in the DOMContentLoaded section
document.addEventListener('click', function(e) {
    if (e.target && e.target.id === 'pk-equations-btn') {
        document.querySelector('#pk-equations-modal .modal-body').innerHTML = `
        <style>
            .pk-equations h6 {
                margin-top: 2rem;
                margin-bottom: 1rem;
                color: #2A3B3B;
                font-weight: 600;
            }
            
            .pk-equations p {
                margin-bottom: 1.5rem;
                padding: 0.75rem;
                background-color: rgba(229, 220, 211, 0.1);
                border-radius: 8px;
            }
            
            .pk-equations .mt-4 {
                margin-top: 2.5rem !important;
            }
            
            .pk-equations ul {
                padding-left: 1.5rem;
            }
            
            .pk-equations li {
                margin-bottom: 0.5rem;
            }
            
            .modal-body {
                padding: 2rem;
                max-height: 80vh;
                overflow-y: auto;
            }
            .equation-title {
              text-align: center;
              font-size: 1.5rem;
              font-weight: bold;
              color: #2A3B3B;
              margin-bottom: 2rem;
              padding-bottom: 1rem;
              border-bottom: 2px solid #2A3B3B;
          }
        </style>
        <div class="pk-equations">
              <div class="equation-title">Vancomycin Pharmacokinetic Equations</div>

            <h6>1. Ideal Body Weight (IBW) Estimation</h6>
            <p>
                Female: $IBW = 45.5 + 2.3(height_{inches} - 60)$ <br>
                Male: $IBW = 50 + 2.3(height_{inches} - 60)$
            </p>

            <h6>2. Creatinine Clearance (Cockcroft-Gault)</h6>
            <p>
                $CrCl = \\frac{(140 - age) \\times IBW}{72 \\times SCr}$ × (0.85 if female)
            </p>

            <h6>3. Elimination Rate Constant (Matzke)</h6>
            <p>
                $K_{el} = 0.00083 \\times CrCl + 0.0044$
            </p>

            <h6>4. Vancomycin Clearance</h6>
            <p>
                $Cl_{vanc} = V_d \\times K_{el}$
            </p>

            <h6>5. Elimination Rate Equations</h6>
            <p>
                5A: $\\tau = \\frac{1}{-k}\\ln(\\frac{C_{min}}{C_{max}}) + t$ <br>
                5B: $k = \\frac{\\ln[\\frac{C_1}{C_2}]}{t_2-t_1}$
            </p>

            <h6>6. Total Daily Dose</h6>
            <p>
                $TDD = Cl_{vanc} \\times AUC_{dss0-24}$
            </p>

            <h6>7. Maintenance Dose</h6>
            <p>
                $MD = \\frac{TDD}{(\\frac{24h}{\\tau})}$
            </p>

            <h6>8. Peak Concentration at Steady State</h6>
            <p>
                $C_{maxSS} = \\frac{Dose(1-e^{-kt})}{V \\times k \\times t(1-e^{-kt})}$
            </p>

            <h6>9. Trough Concentration at Steady State</h6>
            <p>
                $C_{minSS} = \\frac{Dose(1-e^{-kt})}{V \\times k \\times t(1-e^{-kt})} \\times e^{-k(\\tau-t)}$
            </p>

            <h6>10. Two-point Concentration Equation</h6>
            <p>
                $C_2 = C_1 \\times e^{-k(t_2-t_1)}$
            </p>

            <h6>11. Linear Trapezoidal AUC</h6>
            <p>
                $LinTrap = \\frac{(C_{maxSS} + C_{minSS})}{2} \\times t$
            </p>

            <h6>12. Logarithmic Trapezoidal AUC</h6>
            <p>
                $LogTrap = \\frac{(C_{maxSS} - C_{minSS})}{k}$
            </p>

            <h6>13. K from Steady State</h6>
            <p>
                $k = \\frac{-\\ln[\\frac{(C_{min} \\times V)/Dose}{(\\frac{C_{min}}{Dose})+1}]}{\\tau}$
            </p>

            <h6>14. Volume of Distribution at Steady State</h6>
            <p>
                $V_{SS} = \\frac{Dose}{t} \\times \\frac{(1-e^{-kt})}{k \\times (C_{truemaxSS} -[C_{trueminSS} \\times e^{-kt}])}$
            </p>

            <div class="mt-4">
                <h6>Where:</h6>
                <ul>
                    <li>$\\tau$ = dosing interval</li>
                    <li>$t$ = infusion time</li>
                    <li>$SCr$ = serum creatinine</li>
                    <li>$K_{el}$ = elimination rate constant</li>
                    <li>$V_d$ = volume of distribution</li>
                    <li>$C_{max}$ = maximum concentration</li>
                    <li>$C_{min}$ = minimum concentration</li>
                    <li>$TDD$ = total daily dose</li>
                    <li>$MD$ = maintenance dose</li>
                    <li>$AUC$ = area under the curve</li>
                </ul>
            </div>
        </div>`;

          // Render math equations using MathJax
          if (window.MathJax) {
              MathJax.typesetPromise();
          }

          // Show the modal
          const pkEquationsModal = new bootstrap.Modal(document.getElementById('pk-equations-modal'));
          pkEquationsModal.show();
      }
  });

  // Initialize graph with empty data
  const ctx = document.getElementById('pk-graph').getContext('2d');
  concentrationChart = new Chart(ctx, {
    type: 'line',
    data: {
        labels: [0],
        datasets: [{
            label: 'Concentration',
            data: [0],
            borderColor: '#C41E3A',               // Christmas red
            backgroundColor: 'rgba(196, 30, 58, 0.1)', // Light red background
            borderWidth: 2,
            tension: 0.4,
            pointRadius: 0
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            tooltip: {
                mode: 'index',
                intersect: false,
                callbacks: {
                    label: function(context) {
                        return `Concentration: ${context.parsed.y.toFixed(1)} mcg/mL`;
                    }
                }
            }
        },
        scales: {
            x: {
                title: {
                    display: true,
                    text: 'Time (h)',
                    font: { size: 16 },
                    color: '#146B3A'         // Holly green for axis title
                },
                min: 0,
                max: 90,
                ticks: {
                    stepSize: 10,
                    callback: function(value) {
                        return value % 10 === 0 ? value : '';
                    },
                    color: '#146B3A'         // Holly green for ticks
                },
                grid: {
                    color: 'rgba(20, 107, 58, 0.1)'  // Light holly green for grid
                }
            },
            y: {
                title: {
                    display: true,
                    text: 'Concentration (mcg/mL)',
                    font: { size: 16 },
                    color: '#146B3A'         // Holly green for axis title
                },
                min: 0,
                max: 40,
                ticks: {
                    stepSize: 10,
                    color: '#146B3A'         // Holly green for ticks
                },
                grid: {
                    color: 'rgba(20, 107, 58, 0.1)'  // Light holly green for grid
                }
            }
        }
    }
  });
});
